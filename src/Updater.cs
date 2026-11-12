// LM Mini Player - atualizacao automatica.
//
// Ao abrir, o programa le o ultimo release publicado no GitHub. Se houver versao nova, baixa o .zip,
// confere o SHA-256 que o proprio GitHub informa, descompacta numa pasta de espera (dentro de
// %LOCALAPPDATA%\LMMiniPlayer\update) e avisa na tela. Ao clicar em "Atualizar" (ou na proxima vez
// que o programa abrir), os arquivos sao trocados e a versao nova abre.
//
// A troca e feita com cuidado: primeiro todos os arquivos novos sao copiados ao lado dos antigos
// (".new"); so depois os antigos sao renomeados para ".old" (o Windows deixa renomear um programa
// que esta rodando) e os novos tomam o lugar. A versao nova precisa dar sinal de vida; se nao der,
// ela e fechada e tudo volta ao que era. Para desligar tudo: "update=0" no config.ini.
//
// Compila junto com Program.cs (C# 5): veja build.ps1.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

namespace LMMiniPlayer
{
    sealed class UpdateInfo
    {
        public Version Version;
        public string AssetUrl;
        public string Sha256;                    // maiusculo; null se o release nao informou
        public long Size;
        public string PageUrl;

        // so instala sozinho quando sabe de onde baixar e qual deve ser o SHA-256 do arquivo
        public bool CanInstall { get { return !string.IsNullOrEmpty(AssetUrl) && !string.IsNullOrEmpty(Sha256); } }
    }

    sealed class StagedUpdate
    {
        public Version Version;
        public string Dir;
    }

    static class Updater
    {
        const string Repo = "mekea-dev/lm-mini-player";
        const string ExeName = "LMMiniPlayer.exe";
        const string MarkerFile = ".staged-ok";
        const string AssetPattern = @"^LM-Mini-Player-v[0-9][0-9.]*-win-x64\.zip$";
        const long MaxZipBytes = 150L * 1024 * 1024;
        const long MaxUnpackedBytes = 400L * 1024 * 1024;
        const int MaxEntries = 2000;
        const int HandshakeMs = 20000;

        // este processo foi aberto por uma atualizacao (e ja avisou o processo antigo)
        public static bool JustUpdated;

        // Pasta de desenvolvimento (build.ps1 ou .git ao lado do .exe): nunca troca arquivos por cima do codigo-fonte.
        public static bool IsDevCheckout()
        {
            try { return File.Exists(Path.Combine(AppDir, "build.ps1")) || Directory.Exists(Path.Combine(AppDir, ".git")); }
            catch { return false; }
        }

        // a atualizacao automatica vale neste computador? (ligada no config.ini e nao e pasta de desenvolvimento)
        public static bool Enabled(Settings cfg)
        {
            return cfg.AutoUpdate && !IsDevCheckout();
        }

        // ---------- caminhos e versoes ----------

        public static string AppDir
        {
            get { return AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\', '/'); }
        }

        static string StageRoot { get { return Path.Combine(AppPaths.DataDir, "update"); } }

        public static Version Current
        {
            get { return Normalize(Assembly.GetExecutingAssembly().GetName().Version); }
        }

        static Version Normalize(Version v)
        {
            return new Version(Math.Max(0, v.Major), Math.Max(0, v.Minor), Math.Max(0, v.Build), Math.Max(0, v.Revision));
        }

        // "v1.3.1", "1.3" ou "1.3.1.0" -> Version com 4 partes (ou null)
        public static Version ParseVersion(string text)
        {
            if (string.IsNullOrEmpty(text)) return null;
            text = text.Trim();
            if (text.StartsWith("v", StringComparison.OrdinalIgnoreCase)) text = text.Substring(1);
            Match m = Regex.Match(text, @"^(\d{1,4})\.(\d{1,4})(?:\.(\d{1,4}))?(?:\.(\d{1,4}))?$");
            if (!m.Success) return null;
            return new Version(
                int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture),
                int.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture),
                m.Groups[3].Success ? int.Parse(m.Groups[3].Value, CultureInfo.InvariantCulture) : 0,
                m.Groups[4].Success ? int.Parse(m.Groups[4].Value, CultureInfo.InvariantCulture) : 0);
        }

        static string DirNameFor(Version v) { return "v" + v.ToString(4); }

        // ---------- rede ----------

        static bool IsLoopback(string url)
        {
            Uri u;
            if (!Uri.TryCreate(url, UriKind.Absolute, out u)) return false;
            return u.IsLoopback && (u.Scheme == Uri.UriSchemeHttp || u.Scheme == Uri.UriSchemeHttps);
        }

        // so para testes: LMMP_UPDATE_URL aponta para um servidor falso, e SO no proprio computador
        static string TestUrl()
        {
            string over = Environment.GetEnvironmentVariable("LMMP_UPDATE_URL");
            return (!string.IsNullOrEmpty(over) && IsLoopback(over)) ? over : null;
        }

        static string ApiUrl()
        {
            return TestUrl() ?? ("https://api.github.com/repos/" + Repo + "/releases/latest");
        }

        static bool AssetUrlAllowed(string url)
        {
            if (string.IsNullOrEmpty(url)) return false;
            if (TestUrl() != null && IsLoopback(url)) return true;
            return url.StartsWith("https://github.com/" + Repo + "/releases/download/", StringComparison.OrdinalIgnoreCase);
        }

        static void PrepareNetwork()
        {
            try { ServicePointManager.SecurityProtocol |= (SecurityProtocolType)3072; } catch { }      // TLS 1.2
            try { ServicePointManager.Expect100Continue = false; } catch { }
            try
            {
                IWebProxy p = WebRequest.DefaultWebProxy;                                               // proxy de empresa com login do Windows
                if (p != null && p.Credentials == null) p.Credentials = CredentialCache.DefaultCredentials;
            }
            catch { }
        }

        static HttpWebRequest NewRequest(string url, string accept)
        {
            PrepareNetwork();
            HttpWebRequest r = (HttpWebRequest)WebRequest.Create(url);
            r.UserAgent = "LM-Mini-Player/" + Current.ToString(3) + " (auto-update)";
            r.Accept = accept;
            r.Timeout = 20000;
            r.ReadWriteTimeout = 30000;
            r.AllowAutoRedirect = true;
            r.MaximumAutomaticRedirections = 5;
            return r;
        }

        static string HttpGetString(string url)
        {
            HttpWebRequest r = NewRequest(url, "application/vnd.github+json");
            using (WebResponse resp = r.GetResponse())
            using (Stream s = resp.GetResponseStream())
            {
                byte[] buf = new byte[8192];
                MemoryStream ms = new MemoryStream();
                int n;
                while ((n = s.Read(buf, 0, buf.Length)) > 0)
                {
                    ms.Write(buf, 0, n);
                    if (ms.Length > 2 * 1024 * 1024) throw new InvalidDataException("Resposta grande demais.");
                }
                return Encoding.UTF8.GetString(ms.ToArray());
            }
        }

        // ---------- le o release mais recente ----------

        static string Str(Dictionary<string, object> d, string key)
        {
            object o;
            if (d == null || !d.TryGetValue(key, out o) || o == null) return null;
            return Convert.ToString(o, CultureInfo.InvariantCulture);
        }

        // devolve a versao nova (se ha) ou null (ja esta na mais recente). Pode lancar erro de rede.
        public static UpdateInfo CheckLatest()
        {
            string json = HttpGetString(ApiUrl());
            JavaScriptSerializer ser = new JavaScriptSerializer();
            ser.MaxJsonLength = 4 * 1024 * 1024;
            Dictionary<string, object> root = ser.DeserializeObject(json) as Dictionary<string, object>;
            return ReadRelease(root);
        }

        // separado para ser testado sem rede
        public static UpdateInfo ReadRelease(Dictionary<string, object> root)
        {
            if (root == null) return null;
            if (string.Equals(Str(root, "draft"), "True", StringComparison.OrdinalIgnoreCase)) return null;
            if (string.Equals(Str(root, "prerelease"), "True", StringComparison.OrdinalIgnoreCase)) return null;

            Version v = ParseVersion(Str(root, "tag_name"));
            if (v == null || v <= Current) return null;
            bool failedBefore = File.Exists(Path.Combine(StageRoot, "failed-" + DirNameFor(v) + ".txt"));   // ja falhou aqui: nao insiste

            UpdateInfo info = new UpdateInfo();
            info.Version = v;
            info.PageUrl = Str(root, "html_url");
            if (info.PageUrl == null || !info.PageUrl.StartsWith("https://github.com/", StringComparison.OrdinalIgnoreCase))
                info.PageUrl = "https://github.com/" + Repo + "/releases/latest";

            IEnumerable assets = root.ContainsKey("assets") ? root["assets"] as IEnumerable : null;
            if (assets != null)
            {
                foreach (object o in assets)
                {
                    Dictionary<string, object> a = o as Dictionary<string, object>;
                    string name = Str(a, "name");
                    if (name == null || !Regex.IsMatch(name, AssetPattern)) continue;
                    string url = Str(a, "browser_download_url");
                    if (!AssetUrlAllowed(url)) continue;
                    info.AssetUrl = url;
                    long size;
                    if (long.TryParse(Str(a, "size") ?? "", NumberStyles.Integer, CultureInfo.InvariantCulture, out size)) info.Size = size;
                    Match dm = Regex.Match(Str(a, "digest") ?? "", @"^sha256:([0-9a-fA-F]{64})$");
                    if (dm.Success) info.Sha256 = dm.Groups[1].Value.ToUpperInvariant();
                    break;
                }
            }
            if (info.Sha256 == null && info.AssetUrl != null)
            {
                // releases antigos nao tem "digest": o SHA-256 tambem vem escrito nas notas do release
                Match nm = Regex.Match(Str(root, "body") ?? "", @"(?is)SHA-?256.{0,60}?\b([0-9a-fA-F]{64})\b");
                if (nm.Success) info.Sha256 = nm.Groups[1].Value.ToUpperInvariant();
            }
            if (failedBefore) { info.AssetUrl = null; info.Sha256 = null; }       // so avisa; quem quiser baixa no site
            return info;
        }

        // ---------- baixar, conferir e descompactar numa pasta de espera ----------

        public static bool CanWrite()
        {
            try
            {
                string probe = Path.Combine(AppDir, ".lmmp-write-test-" + Guid.NewGuid().ToString("N"));
                File.WriteAllText(probe, "x");
                File.Delete(probe);
                return true;
            }
            catch { return false; }
        }

        // a versao baixada que esta pronta para instalar (a mais nova), ou null
        public static StagedUpdate FindStaged()
        {
            try
            {
                if (!Directory.Exists(StageRoot)) return null;
                StagedUpdate best = null;
                foreach (string dir in Directory.GetDirectories(StageRoot, "v*"))
                {
                    string name = Path.GetFileName(dir);
                    if (name.EndsWith(".tmp", StringComparison.OrdinalIgnoreCase)) continue;
                    Version v = ParseVersion(name);
                    if (v == null || v <= Current) continue;
                    if (!File.Exists(Path.Combine(dir, MarkerFile)) || !File.Exists(Path.Combine(dir, ExeName))) continue;
                    if (File.Exists(Path.Combine(StageRoot, "failed-" + DirNameFor(v) + ".txt"))) continue;
                    if (best == null || v > best.Version) best = new StagedUpdate { Version = v, Dir = dir };
                }
                return best;
            }
            catch { return null; }
        }

        public static StagedUpdate Stage(UpdateInfo info)
        {
            if (!info.CanInstall) throw new InvalidOperationException("Sem endereco ou SHA-256 do arquivo.");
            string root = StageRoot;
            Directory.CreateDirectory(root);
            string name = DirNameFor(info.Version);
            string finalDir = Path.Combine(root, name);
            string tmpDir = finalDir + ".tmp";
            string zipPart = Path.Combine(root, "download.zip.part");

            if (Directory.Exists(finalDir) && File.Exists(Path.Combine(finalDir, MarkerFile)))
                return new StagedUpdate { Version = info.Version, Dir = finalDir };

            SafeDeleteDir(tmpDir);
            SafeDeleteDir(finalDir);
            SafeDeleteFile(zipPart);
            try
            {
                string actual = Download(info.AssetUrl, zipPart, info.Size);
                if (!string.Equals(actual, info.Sha256, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("O SHA-256 do arquivo baixado nao confere.");

                Directory.CreateDirectory(tmpDir);
                Unzip(zipPart, tmpDir);

                string exe = Path.Combine(tmpDir, ExeName);
                if (!File.Exists(exe) || !File.Exists(Path.Combine(tmpDir, "web", "index.html")))
                    throw new InvalidDataException("O pacote nao tem o programa completo.");
                Version got = ParseVersion(FileVersionInfo.GetVersionInfo(exe).FileVersion);
                if (got == null || got != info.Version)
                    throw new InvalidDataException("A versao dentro do pacote (" + (got == null ? "?" : got.ToString(3)) + ") nao e a anunciada.");

                File.WriteAllText(Path.Combine(tmpDir, MarkerFile), info.Sha256);
                Directory.Move(tmpDir, finalDir);
            }
            catch
            {
                SafeDeleteDir(tmpDir);
                throw;
            }
            finally
            {
                SafeDeleteFile(zipPart);
            }

            // versoes de espera mais velhas nao servem mais
            try
            {
                foreach (string dir in Directory.GetDirectories(root, "v*"))
                    if (!string.Equals(dir, finalDir, StringComparison.OrdinalIgnoreCase)) SafeDeleteDir(dir);
            }
            catch { }
            return new StagedUpdate { Version = info.Version, Dir = finalDir };
        }

        // baixa para o arquivo e devolve o SHA-256 (maiusculo) do que chegou
        static string Download(string url, string path, long expectedSize)
        {
            HttpWebRequest r = NewRequest(url, "application/octet-stream");
            r.Timeout = 30000;
            using (WebResponse resp = r.GetResponse())
            {
                long len = resp.ContentLength;
                if (len > MaxZipBytes || expectedSize > MaxZipBytes) throw new InvalidDataException("Arquivo grande demais.");
                using (Stream s = resp.GetResponseStream())
                using (FileStream fs = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.None))
                using (SHA256 sha = SHA256.Create())
                {
                    byte[] buf = new byte[64 * 1024];
                    long total = 0;
                    int n;
                    while ((n = s.Read(buf, 0, buf.Length)) > 0)
                    {
                        total += n;
                        if (total > MaxZipBytes) throw new InvalidDataException("Arquivo grande demais.");
                        fs.Write(buf, 0, n);
                        sha.TransformBlock(buf, 0, n, null, 0);
                    }
                    sha.TransformFinalBlock(new byte[0], 0, 0);
                    if (expectedSize > 0 && total != expectedSize) throw new InvalidDataException("O arquivo baixado veio incompleto.");
                    return BitConverter.ToString(sha.Hash).Replace("-", "");
                }
            }
        }

        // descompacta tirando a pasta "LM-Mini-Player/" do comeco; recusa caminhos que saiam da pasta de destino
        public static void Unzip(string zipPath, string destDir)
        {
            string destFull = Path.GetFullPath(destDir).TrimEnd('\\') + "\\";
            long total = 0;
            using (FileStream fs = new FileStream(zipPath, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (ZipArchive za = new ZipArchive(fs, ZipArchiveMode.Read))
            {
                if (za.Entries.Count > MaxEntries) throw new InvalidDataException("Pacote com arquivos demais.");

                // todos dentro da mesma pasta de nivel 1? entao ela e tirada
                string prefix = null;
                bool same = true;
                foreach (ZipArchiveEntry e in za.Entries)
                {
                    string n = e.FullName.Replace('\\', '/');
                    int i = n.IndexOf('/');
                    string first = i > 0 ? n.Substring(0, i + 1) : "";
                    if (prefix == null) prefix = first; else if (prefix != first) same = false;
                }
                if (!same || prefix == null) prefix = "";

                foreach (ZipArchiveEntry e in za.Entries)
                {
                    string n = e.FullName.Replace('\\', '/');
                    if (n.EndsWith("/")) continue;                                  // pasta
                    if (prefix.Length > 0) n = n.Substring(prefix.Length);
                    if (n.Length == 0) continue;
                    if (n.StartsWith("/") || n.IndexOf(':') >= 0 || n.Contains("../") || n.StartsWith("..")) throw new InvalidDataException("Caminho suspeito no pacote: " + e.FullName);

                    string target = Path.GetFullPath(Path.Combine(destFull, n.Replace('/', '\\')));
                    if (!target.StartsWith(destFull, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Caminho suspeito no pacote: " + e.FullName);

                    total += e.Length;
                    if (total > MaxUnpackedBytes) throw new InvalidDataException("Pacote grande demais.");
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    using (Stream src = e.Open())
                    using (FileStream dst = new FileStream(target, FileMode.Create, FileAccess.Write, FileShare.None))
                    {
                        byte[] buf = new byte[64 * 1024];
                        int k;
                        while ((k = src.Read(buf, 0, buf.Length)) > 0) dst.Write(buf, 0, k);
                    }
                }
            }
        }

        // ---------- trocar os arquivos ----------

        sealed class Swap
        {
            public string Source;     // arquivo novo, na pasta de espera
            public string Dest;       // arquivo no lugar de uso
            public string Staged;     // copia nova ao lado ("Dest.new")
            public string Old;        // onde o antigo foi parar ("Dest.old"); null enquanto ele nao foi mexido
            public bool Done;         // o novo ja esta no lugar
        }

        // Troca os arquivos e abre a versao nova. true = a versao nova abriu e confirmou (este processo deve encerrar);
        // false = deu errado e tudo voltou como estava.
        public static bool ApplyAndRelaunch(StagedUpdate st, string extraArgs)
        {
            string appDir = AppDir;
            List<Swap> swaps = new List<Swap>();
            try
            {
                string srcRoot = st.Dir.TrimEnd('\\') + "\\";
                foreach (string f in Directory.GetFiles(st.Dir, "*", SearchOption.AllDirectories))
                {
                    string rel = f.Substring(srcRoot.Length);
                    if (string.Equals(rel, MarkerFile, StringComparison.OrdinalIgnoreCase)) continue;
                    string dest = Path.Combine(appDir, rel);
                    swaps.Add(new Swap { Source = f, Dest = dest, Staged = dest + ".new" });
                }
                // o .exe por ultimo: se algo falhar no meio, o programa antigo continua inteiro
                swaps.Sort(delegate(Swap a, Swap b)
                {
                    int ea = a.Dest.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? 1 : 0;
                    int eb = b.Dest.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? 1 : 0;
                    return ea != eb ? ea.CompareTo(eb) : string.Compare(a.Dest, b.Dest, StringComparison.OrdinalIgnoreCase);
                });

                // 1) copia tudo que e novo para ao lado dos antigos (se faltar disco ou permissao, nada foi mexido)
                foreach (Swap s in swaps)
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(s.Dest));
                    Swap cur = s;
                    Retry(delegate { File.Copy(cur.Source, cur.Staged, true); });
                }
                // 2) renomeia o antigo e poe o novo no lugar (so renomeacoes: rapido)
                foreach (Swap s in swaps)
                {
                    Swap cur = s;
                    if (File.Exists(cur.Dest))
                    {
                        string old = UniqueOldName(cur.Dest);
                        Retry(delegate { File.Move(cur.Dest, old); });
                        cur.Old = old;
                    }
                    Retry(delegate { File.Move(cur.Staged, cur.Dest); });
                    cur.Done = true;
                }
                RememberLeftovers(swaps);
            }
            catch (Exception ex)
            {
                AppLog.Error(ex);
                Rollback(swaps);
                return false;
            }

            // 3) abre a versao nova e espera ela dizer que esta viva
            int myPid = Process.GetCurrentProcess().Id;
            string evName = "Local\\LMMiniPlayer.Update." + myPid.ToString(CultureInfo.InvariantCulture);
            Process child = null;
            try
            {
                using (EventWaitHandle alive = new EventWaitHandle(false, EventResetMode.ManualReset, evName))
                {
                    ProcessStartInfo psi = new ProcessStartInfo(Path.Combine(appDir, ExeName));
                    psi.Arguments = "--after-update " + myPid.ToString(CultureInfo.InvariantCulture) + (string.IsNullOrEmpty(extraArgs) ? "" : " " + extraArgs);
                    psi.UseShellExecute = false;
                    psi.WorkingDirectory = appDir;
                    child = Process.Start(psi);
                    int waited = 0;
                    while (waited < HandshakeMs)
                    {
                        if (alive.WaitOne(250)) return true;
                        waited += 250;
                        if (child.HasExited) break;                                  // a versao nova caiu ao abrir: nem espera mais
                    }
                }
            }
            catch (Exception ex)
            {
                AppLog.Error(ex);
            }

            // a versao nova nao deu sinal: fecha ela e volta tudo ao que era
            try { if (child != null && !child.HasExited) { child.Kill(); child.WaitForExit(5000); } } catch { }
            Rollback(swaps);
            ForgetLeftovers();
            return false;
        }

        // o antivirus as vezes segura um arquivo recem-criado por alguns instantes: tenta de novo antes de desistir
        static void Retry(Action action)
        {
            for (int attempt = 1; ; attempt++)
            {
                try { action(); return; }
                catch (IOException) { if (attempt >= 6) throw; }
                catch (UnauthorizedAccessException) { if (attempt >= 6) throw; }
                Thread.Sleep(250);
            }
        }

        static string UniqueOldName(string dest)
        {
            string old = dest + ".old";
            if (!File.Exists(old)) return old;
            try { File.Delete(old); return old; } catch { }
            for (int i = 2; i < 100; i++)
            {
                old = dest + ".old" + i.ToString(CultureInfo.InvariantCulture);
                if (!File.Exists(old)) return old;
            }
            throw new IOException("Nao consegui reservar um nome para o arquivo antigo: " + dest);
        }

        static void Rollback(List<Swap> swaps)
        {
            for (int i = swaps.Count - 1; i >= 0; i--)
            {
                Swap s = swaps[i];
                SafeDeleteFile(s.Staged);
                if (!s.Done && s.Old == null) continue;                            // esse arquivo nem foi mexido
                for (int attempt = 0; attempt < 10; attempt++)
                {
                    try
                    {
                        if (s.Old != null)
                        {
                            if (s.Done && File.Exists(s.Dest)) File.Delete(s.Dest);   // tira o novo (so se ele chegou a entrar)
                            if (File.Exists(s.Old)) File.Move(s.Old, s.Dest);          // devolve o antigo
                        }
                        else if (File.Exists(s.Dest))
                        {
                            File.Delete(s.Dest);                                   // arquivo que nao existia antes
                        }
                        break;
                    }
                    catch { Thread.Sleep(300); }                                   // o processo da versao nova ainda esta saindo
                }
            }
        }

        // ---- lista dos ".old" que a troca deixou: so esses sao apagados depois (nunca "tudo que parece velho") ----

        static string LeftoverList { get { return Path.Combine(StageRoot, "cleanup.txt"); } }

        static void RememberLeftovers(List<Swap> swaps)
        {
            try
            {
                Directory.CreateDirectory(StageRoot);
                List<string> lines = new List<string>();
                foreach (Swap s in swaps) if (s.Old != null) lines.Add(s.Old);
                File.WriteAllLines(LeftoverList, lines.ToArray(), Encoding.UTF8);
            }
            catch { }
        }

        static void ForgetLeftovers()
        {
            SafeDeleteFile(LeftoverList);
        }

        // marca a versao como "nao deu certo aqui" para nao tentar de novo em loop
        public static void MarkFailed(StagedUpdate st)
        {
            try
            {
                Directory.CreateDirectory(StageRoot);
                File.WriteAllText(Path.Combine(StageRoot, "failed-" + DirNameFor(st.Version) + ".txt"),
                    DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture));
                SafeDeleteDir(st.Dir);
            }
            catch { }
        }

        // ---------- inicio do programa ----------

        // Se este processo foi aberto por uma atualizacao ("--after-update <pid> ..."), avisa o antigo e tira esses argumentos.
        public static string[] OnStartup(string[] args)
        {
            if (args == null) return new string[0];
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] != "--after-update") continue;
                int pid;
                if (i + 1 < args.Length && int.TryParse(args[i + 1], NumberStyles.Integer, CultureInfo.InvariantCulture, out pid))
                {
                    try
                    {
                        using (EventWaitHandle h = EventWaitHandle.OpenExisting("Local\\LMMiniPlayer.Update." + pid.ToString(CultureInfo.InvariantCulture)))
                            h.Set();
                    }
                    catch { }
                    JustUpdated = true;
                    List<string> rest = new List<string>(args);
                    rest.RemoveRange(i, 2);
                    return rest.ToArray();
                }
            }
            return args;
        }

        // Ha atualizacao ja baixada e este e o unico programa aberto? Troca os arquivos e abre a versao nova
        // (true = este processo deve encerrar). Roda antes de a janela existir, entao nao pisca nada na tela.
        public static bool TryApplyAtStart(string[] args, Settings cfg)
        {
            try
            {
                if (JustUpdated || !Enabled(cfg)) return false;
                StagedUpdate st = FindStaged();
                if (st == null) return false;
                if (OtherInstances() > 0 || !CanWrite()) return false;
                if (ApplyAndRelaunch(st, JoinArgs(args))) return true;
                MarkFailed(st);
            }
            catch (Exception ex) { AppLog.Error(ex); }
            return false;
        }

        static int OtherInstances()
        {
            try { return Process.GetProcessesByName(Process.GetCurrentProcess().ProcessName).Length - 1; }
            catch { return 0; }
        }

        public static string JoinArgs(string[] args)
        {
            if (args == null || args.Length == 0) return "";
            StringBuilder sb = new StringBuilder();
            foreach (string a in args)
            {
                if (sb.Length > 0) sb.Append(' ');
                sb.Append(QuoteArg(a));
            }
            return sb.ToString();
        }

        public static string QuoteArg(string a)
        {
            if (a.Length > 0 && a.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0) return a;
            return "\"" + a.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
        }

        // ---------- limpeza ----------

        // apaga os arquivos antigos que a troca deixou (so os da lista) e as versoes de espera que ja foram instaladas;
        // devolve true quando nao sobrou nada
        public static bool Cleanup()
        {
            bool clean = true;
            try
            {
                if (File.Exists(LeftoverList))
                {
                    string appPrefix = AppDir + "\\";
                    List<string> remaining = new List<string>();
                    foreach (string line in File.ReadAllLines(LeftoverList, Encoding.UTF8))
                    {
                        string f = line.Trim();
                        if (f.Length == 0) continue;
                        // so apaga o que esta dentro da pasta do programa e termina em .old / .old2...
                        if (!f.StartsWith(appPrefix, StringComparison.OrdinalIgnoreCase) || !Regex.IsMatch(f, @"\.old\d{0,2}$", RegexOptions.IgnoreCase)) continue;
                        try { if (File.Exists(f)) File.Delete(f); }
                        catch { remaining.Add(f); clean = false; }                // ainda em uso (o processo antigo esta saindo)
                    }
                    if (remaining.Count == 0) File.Delete(LeftoverList);
                    else File.WriteAllLines(LeftoverList, remaining.ToArray(), Encoding.UTF8);
                }
            }
            catch { clean = false; }
            try
            {
                if (Directory.Exists(StageRoot))
                {
                    foreach (string dir in Directory.GetDirectories(StageRoot, "v*"))
                    {
                        Version v = ParseVersion(Path.GetFileName(dir));
                        if (dir.EndsWith(".tmp", StringComparison.OrdinalIgnoreCase) || v == null || v <= Current) SafeDeleteDir(dir);
                    }
                    foreach (string f in Directory.GetFiles(StageRoot, "*.part")) SafeDeleteFile(f);
                }
            }
            catch { }
            return clean;
        }

        static void SafeDeleteFile(string path)
        {
            try { if (File.Exists(path)) File.Delete(path); } catch { }
        }

        static void SafeDeleteDir(string path)
        {
            try { if (Directory.Exists(path)) Directory.Delete(path, true); } catch { }
        }
    }
}
