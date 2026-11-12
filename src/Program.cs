// LM Mini Player - janela flutuante (sempre por cima) que toca videos do YouTube.
//
// A janela e so uma "moldura": o video e a interface vivem em web\ (HTML/CSS/JS) e rodam
// dentro do WebView2 (o motor do Edge que ja vem no Windows). Este arquivo cuida do que a
// pagina nao consegue: ficar por cima de tudo, mover/redimensionar sem borda, transparencia,
// tela cheia, lembrar posicao e tamanho, e o Ctrl+V com o foco dentro do video.
//
// Compila com o csc.exe que ja vem no Windows (C# 5): veja build.ps1.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;

[assembly: AssemblyTitle("LM Mini Player")]
[assembly: AssemblyProduct("LM Mini Player")]
[assembly: AssemblyDescription("Mini player de YouTube que fica por cima das outras janelas")]
[assembly: AssemblyCopyright("Copyright (c) 2026 Leonardo Maquea")]
[assembly: AssemblyVersion("1.3.1.0")]
[assembly: AssemblyFileVersion("1.3.1.0")]

namespace LMMiniPlayer
{
    static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            // erro inesperado vai para o erro.log, em vez de uma janela tecnica do .NET
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
            Application.ThreadException += delegate(object s, System.Threading.ThreadExceptionEventArgs e) { AppLog.Error(e.Exception); };
            AppDomain.CurrentDomain.UnhandledException += delegate(object s, UnhandledExceptionEventArgs e) { AppLog.Error(e.ExceptionObject as Exception); };

            // atualizacao automatica: este processo foi aberto por uma atualizacao? Avisa o antigo e segue.
            args = Updater.OnStartup(args);
            // ha versao nova ja baixada e este e o unico programa aberto? Troca os arquivos, abre a nova e encerra aqui.
            if (Updater.TryApplyAtStart(args, Settings.Load())) return;

            Application.Run(new MainForm(args));
        }
    }

    static class AppLog
    {
        public static void Error(Exception ex)
        {
            try
            {
                Directory.CreateDirectory(AppPaths.DataDir);
                string file = Path.Combine(AppPaths.DataDir, "erro.log");
                if (File.Exists(file) && new FileInfo(file).Length > 256 * 1024) File.Delete(file);
                File.AppendAllText(file,
                    DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture) + "  " +
                    (ex == null ? "(erro desconhecido)" : ex.ToString()) + "\r\n\r\n");
            }
            catch { /* nao ha mais o que fazer */ }
        }
    }

    static class AppPaths
    {
        // %LOCALAPPDATA%\LMMiniPlayer: configuracao e dados do WebView2 (cookies, volume do YouTube...)
        // (LMMP_DATA_DIR troca a pasta: usado nos testes para nao mexer nos dados de quem usa o programa)
        public static string DataDir
        {
            get
            {
                string over = Environment.GetEnvironmentVariable("LMMP_DATA_DIR");
                if (!string.IsNullOrEmpty(over)) return over;
                return Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "LMMiniPlayer");
            }
        }
    }

    static class Native
    {
        [StructLayout(LayoutKind.Sequential)]
        public struct POINT { public int X; public int Y; }

        [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
        [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
        [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
        [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
        [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
    }

    // posicao, tamanho, "sempre por cima", transparencia e atualizacao automatica, gravados em config.ini
    sealed class Settings
    {
        public int X = int.MinValue;
        public int Y = int.MinValue;
        public int W = 0;
        public int H = 0;
        public bool Pin = true;
        public double Opacity = 1.0;
        public bool AutoUpdate = true;                    // "update=0" no config.ini desliga a verificacao de versao nova

        public bool HasBounds { get { return X != int.MinValue && Y != int.MinValue; } }

        static string FilePath { get { return Path.Combine(AppPaths.DataDir, "config.ini"); } }

        public static Settings Load()
        {
            var s = new Settings();
            try
            {
                if (!File.Exists(FilePath)) return s;
                foreach (string raw in File.ReadAllLines(FilePath))
                {
                    int i = raw.IndexOf('=');
                    if (i <= 0) continue;
                    string k = raw.Substring(0, i).Trim().ToLowerInvariant();
                    string v = raw.Substring(i + 1).Trim();
                    int n;
                    double d;
                    switch (k)
                    {
                        case "x": if (int.TryParse(v, NumberStyles.Integer, CultureInfo.InvariantCulture, out n)) s.X = n; break;
                        case "y": if (int.TryParse(v, NumberStyles.Integer, CultureInfo.InvariantCulture, out n)) s.Y = n; break;
                        case "w": if (int.TryParse(v, NumberStyles.Integer, CultureInfo.InvariantCulture, out n)) s.W = n; break;
                        case "h": if (int.TryParse(v, NumberStyles.Integer, CultureInfo.InvariantCulture, out n)) s.H = n; break;
                        case "pin": s.Pin = v != "0"; break;
                        case "update": s.AutoUpdate = v != "0"; break;
                        case "opacity":
                            if (double.TryParse(v, NumberStyles.Float, CultureInfo.InvariantCulture, out d))
                                s.Opacity = Math.Max(0.25, Math.Min(1.0, d));
                            break;
                    }
                }
            }
            catch { /* config corrompida: segue com os padroes */ }
            return s;
        }

        public void Save()
        {
            try
            {
                Directory.CreateDirectory(AppPaths.DataDir);
                string[] lines = new string[]
                {
                    "x=" + X.ToString(CultureInfo.InvariantCulture),
                    "y=" + Y.ToString(CultureInfo.InvariantCulture),
                    "w=" + W.ToString(CultureInfo.InvariantCulture),
                    "h=" + H.ToString(CultureInfo.InvariantCulture),
                    "pin=" + (Pin ? "1" : "0"),
                    "opacity=" + Opacity.ToString("0.##", CultureInfo.InvariantCulture),
                    "update=" + (AutoUpdate ? "1" : "0")
                };
                File.WriteAllText(FilePath, string.Join("\r\n", lines) + "\r\n");
            }
            catch { /* sem permissao de escrita: so nao lembra da posicao */ }
        }
    }

    // janela de navegacao que fica por baixo da barra do programa (busca do YouTube, Spotify...)
    sealed class BrowseModule
    {
        public string Name;
        public string HomeUrl;
        public bool Muted;                      // sem som: a busca do YouTube so serve para escolher, quem toca e o nosso player
        public string[] AllowedHosts;           // dominios permitidos na janela principal do modulo (o resto abre no navegador)
        public string ScriptFile;               // script injetado nas paginas do modulo (opcional), dentro de web\
        public Task CreateTask;
        public CoreWebView2Controller Controller;
        public CoreWebView2 Core;
    }

    sealed class MainForm : Form
    {
        const string VHost = "lmminiplayer.app";                       // nome virtual: aponta para a pasta web\
        const string HomeUrl = "https://" + VHost + "/index.html";
        const int IdleHideMs = 2500;                                   // barra some depois de 2,5 s sem mexer o mouse

        readonly Settings cfg;
        readonly string startText;                                     // link recebido na linha de comando ou da area de transferencia
        readonly Timer hoverTimer = new Timer();                       // avisa a pagina quando o mouse esta sobre a janela
        readonly Timer gestureTimer = new Timer();                     // acompanha o mouse ao mover/redimensionar

        CoreWebView2Controller controller;
        CoreWebView2 core;
        bool pageReady;
        bool typing;                                                   // a pagina esta com o cursor num campo de texto
        bool pinned;                                                   // preferencia do usuario: sempre por cima

        string gesture;                                                // "move" ou borda: n s e w ne nw se sw
        Point gestureCursor;
        Rectangle gestureBounds;

        Point lastCursor;
        int lastMove;
        bool lastActive;

        bool fullscreen;
        Rectangle boundsBeforeFull;

        // modulos: um WebView2 a mais por modulo, criado so quando usado, por baixo da barra do programa
        const int BrowseBarDip = 44;                                   // altura da barra de busca (igual a --browse-h em app.css)
        const int BrowseEdgeDip = 6;                                   // margem para as alcas de redimensionar (igual a --rz)
        static readonly Regex WatchUrl = new Regex(@"^https://(m|www|music)\.youtube\.com/(watch\?|shorts/|live/)", RegexOptions.IgnoreCase);
        readonly Dictionary<string, BrowseModule> modules = new Dictionary<string, BrowseModule>();
        BrowseModule activeModule;
        CoreWebView2Environment env;
        string webDir;
        int modSeq;                                                    // descarta pedidos de modulo que chegam atrasados

        // atualizacao automatica (a logica fica em Updater.cs)
        const int UpdateEveryMs = 6 * 60 * 60 * 1000;                  // olha o GitHub de novo a cada 6 horas
        static readonly Regex ResumeLink = new Regex(@"^https://(youtu\.be/[A-Za-z0-9_-]{11}(\?[A-Za-z0-9_=&.-]{0,200})?|www\.youtube\.com/playlist\?list=[A-Za-z0-9_-]{10,80})$");
        readonly Timer updateTimer = new Timer();
        bool updateStarted;
        bool updateBusy;                                               // verificando, baixando ou instalando
        bool updateReady;                                              // versao nova ja baixada, pronta para instalar
        Version updateVersion;                                         // versao nova que o GitHub anunciou (null = nenhuma)
        string updatePage;                                             // pagina do release (botao "Baixar")
        readonly bool startMinimized;                                  // aberto com --minimized

        public MainForm(string[] args)
        {
            cfg = Settings.Load();
            pinned = cfg.Pin;

            List<string> rest = new List<string>();
            if (args != null)
            {
                foreach (string a in args)
                {
                    if (a == "--minimized") startMinimized = true; else rest.Add(a);
                }
            }
            args = rest.ToArray();

            Text = "LM Mini Player";
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            ShowInTaskbar = true;
            BackColor = Color.Black;

            float scale = DpiScale();
            MinimumSize = new Size((int)(240 * scale), (int)(135 * scale));
            Bounds = InitialBounds(scale);
            TopMost = pinned;
            Opacity = cfg.Opacity;
            if (startMinimized) WindowState = FormWindowState.Minimized;
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            startText = StartLink(args);

            hoverTimer.Interval = 100;
            hoverTimer.Tick += OnHoverTick;
            gestureTimer.Interval = 10;
            gestureTimer.Tick += OnGestureTick;

            SizeChanged += delegate { FitController(); };
            Activated += delegate
            {
                CoreWebView2Controller c = (activeModule != null && activeModule.Controller != null) ? activeModule.Controller : controller;
                if (c != null)
                {
                    try { c.MoveFocus(CoreWebView2MoveFocusReason.Programmatic); } catch { }
                }
            };
        }

        // ---------- janela ----------

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.Style |= 0x00020000;   // WS_MINIMIZEBOX: o botao da barra de tarefas consegue minimizar a janela
                return cp;
            }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            try
            {
                int round = 2;            // DWMWCP_ROUND: cantos arredondados no Windows 11
                Native.DwmSetWindowAttribute(Handle, 33, ref round, 4);
            }
            catch { }
        }

        protected override async void OnShown(EventArgs e)
        {
            base.OnShown(e);
            try
            {
                await InitWebView();
            }
            catch (WebView2RuntimeNotFoundException)
            {
                MessageBox.Show(this,
                    "O LM Mini Player precisa do \"WebView2 Runtime\" da Microsoft (ele ja vem no Windows 11 e no Windows 10 atualizado).\r\n\r\n" +
                    "Vou abrir a pagina de download no navegador. Instale e abra o programa de novo.",
                    "LM Mini Player", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                OpenExternal("https://developer.microsoft.com/microsoft-edge/webview2/");
                Close();
            }
            catch (Exception ex)
            {
                AppLog.Error(ex);
                MessageBox.Show(this, "Nao foi possivel iniciar o player:\r\n\r\n" + ex.Message,
                    "LM Mini Player", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
            }
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            SaveSettings();
            hoverTimer.Stop();
            gestureTimer.Stop();
            base.OnFormClosing(e);
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            foreach (BrowseModule o in modules.Values)
            {
                if (o.Controller != null) { try { o.Controller.Close(); } catch { } o.Controller = null; }
            }
            if (controller != null)
            {
                try { controller.Close(); } catch { }
                controller = null;
            }
            base.OnFormClosed(e);
        }

        static float DpiScale()
        {
            try { using (Graphics g = Graphics.FromHwnd(IntPtr.Zero)) return g.DpiX / 96f; }
            catch { return 1f; }
        }

        Rectangle InitialBounds(float scale)
        {
            int w = cfg.W > 0 ? cfg.W : (int)(480 * scale);
            int h = cfg.H > 0 ? cfg.H : (int)(270 * scale);
            w = Math.Max(MinimumSize.Width, w);
            h = Math.Max(MinimumSize.Height, h);

            Rectangle result = Rectangle.Empty;
            if (cfg.HasBounds)
            {
                var saved = new Rectangle(cfg.X, cfg.Y, w, h);
                foreach (Screen s in Screen.AllScreens)
                {
                    Rectangle vis = Rectangle.Intersect(s.WorkingArea, saved);
                    if (vis.Width >= 120 && vis.Height >= 60) { result = saved; break; }   // ainda aparece em alguma tela
                }
            }

            if (result.IsEmpty)
            {
                // padrao: canto inferior direito da tela onde esta o mouse
                Rectangle wa = Screen.FromPoint(Cursor.Position).WorkingArea;
                int m = (int)(24 * scale);
                w = Math.Min(w, Math.Max(MinimumSize.Width, wa.Width - 2 * m));
                h = Math.Min(h, Math.Max(MinimumSize.Height, wa.Height - 2 * m));
                result = new Rectangle(wa.Right - w - m, wa.Bottom - h - m, w, h);
            }

            // ja ha outra janela aberta? esta nasce deslocada, para nao ficar escondida exatamente em cima dela
            int others = 0;
            try { others = Process.GetProcessesByName(Process.GetCurrentProcess().ProcessName).Length - 1; } catch { }
            if (others > 0)
            {
                int step = (int)(36 * scale) * others;
                Rectangle area = Screen.FromRectangle(result).WorkingArea;
                result.X = Math.Max(area.Left, Math.Min(result.X + step, area.Right - result.Width));
                result.Y = Math.Max(area.Top, Math.Min(result.Y + step, area.Bottom - result.Height));
            }
            return result;
        }

        void SaveSettings()
        {
            if (WindowState == FormWindowState.Normal && !fullscreen)
            {
                cfg.X = Left;
                cfg.Y = Top;
                cfg.W = Width;
                cfg.H = Height;
            }
            cfg.Pin = pinned;
            cfg.Opacity = Opacity;
            cfg.Save();
        }

        // area onde a pagina aparece (minimizada, vale o tamanho de antes de minimizar)
        Size ViewSize()
        {
            return WindowState == FormWindowState.Minimized ? RestoreBounds.Size : ClientSize;
        }

        void FitController()
        {
            if (controller == null) return;
            Size view = ViewSize();
            if (view.Width <= 0 || view.Height <= 0) return;
            try
            {
                controller.Bounds = new Rectangle(0, 0, view.Width, view.Height);
                controller.IsVisible = true;
                if (activeModule != null && activeModule.Controller != null)
                {
                    activeModule.Controller.Bounds = ModuleBounds();
                    activeModule.Controller.IsVisible = true;
                }
            }
            catch { }
        }

        // ---------- WebView2 ----------

        async Task InitWebView()
        {
            webDir = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "web");
            if (!File.Exists(Path.Combine(webDir, "index.html")))
                throw new FileNotFoundException("A pasta \"web\" precisa ficar ao lado do LMMiniPlayer.exe.");

            var options = new CoreWebView2EnvironmentOptions();
            // sem isso o Chromium bloqueia o play automatico quando o video e colado por fora da pagina
            options.AdditionalBrowserArguments = "--autoplay-policy=no-user-gesture-required";

            env = await CoreWebView2Environment.CreateAsync(
                null, Path.Combine(AppPaths.DataDir, "WebView2"), options);

            // modulos de navegacao (so sao criados quando o usuario abre um deles)
            modules["youtube"] = new BrowseModule
            {
                Name = "youtube",
                HomeUrl = "https://m.youtube.com/",
                Muted = true,
                ScriptFile = "yt-browse.js",
                AllowedHosts = new string[] { "youtube.com", "google.com", "gstatic.com" }
            };
            modules["spotify"] = new BrowseModule
            {
                Name = "spotify",
                HomeUrl = "https://open.spotify.com/",
                Muted = false,
                AllowedHosts = new string[] { "spotify.com", "scdn.co", "spotifycdn.com", "google.com", "gstatic.com", "facebook.com", "apple.com" }
            };

            controller = await env.CreateCoreWebView2ControllerAsync(Handle);
            core = controller.CoreWebView2;

            controller.DefaultBackgroundColor = Color.Black;
            FitController();

            CoreWebView2Settings st = core.Settings;
            st.AreDefaultContextMenusEnabled = false;
            st.AreDevToolsEnabled = false;
            st.IsStatusBarEnabled = false;
            st.IsZoomControlEnabled = false;
            st.AreBrowserAcceleratorKeysEnabled = false;

            core.SetVirtualHostNameToFolderMapping(VHost, webDir, CoreWebView2HostResourceAccessKind.Allow);

            // velocidade livre e atalhos DENTRO do player do YouTube (iframe de outra origem: so da para
            // mexer nele injetando o script em todos os quadros; o script so age no player incorporado)
            string frameScript = Path.Combine(webDir, "speed-frame.js");
            if (File.Exists(frameScript))
            {
                try { await core.AddScriptToExecuteOnDocumentCreatedAsync(File.ReadAllText(frameScript, System.Text.Encoding.UTF8)); }
                catch (Exception ex) { AppLog.Error(ex); }
            }

            core.WebMessageReceived += OnWebMessage;
            core.DocumentTitleChanged += delegate { Text = string.IsNullOrEmpty(core.DocumentTitle) ? "LM Mini Player" : core.DocumentTitle; };
            core.ContainsFullScreenElementChanged += OnFullScreenChanged;
            core.ProcessFailed += OnProcessFailed;
            core.PermissionRequested += delegate(object s, CoreWebView2PermissionRequestedEventArgs e) { e.State = CoreWebView2PermissionState.Deny; };
            // cliques que abririam outra janela (logo do YouTube, canal...) vao para o navegador padrao
            core.NewWindowRequested += delegate(object s, CoreWebView2NewWindowRequestedEventArgs e) { e.Handled = true; OpenExternal(e.Uri); };
            // a janela principal nunca sai da nossa pagina
            core.NavigationStarting += delegate(object s, CoreWebView2NavigationStartingEventArgs e)
            {
                if (!e.Uri.StartsWith("https://" + VHost + "/", StringComparison.OrdinalIgnoreCase)) e.Cancel = true;
            };
            controller.AcceleratorKeyPressed += OnAccelerator;

            core.Navigate(HomeUrl);
        }

        void Send(string msg)
        {
            if (core == null) return;
            try { core.PostWebMessageAsString(msg); } catch { }
        }

        // mensagens da pagina: "comando" ou "comando:argumento"
        void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            // so a nossa pagina manda comandos (o iframe do YouTube nao)
            string src = e.Source ?? "";
            if (!src.StartsWith("https://" + VHost + "/", StringComparison.OrdinalIgnoreCase)) return;

            string msg;
            try { msg = e.TryGetWebMessageAsString(); } catch { return; }
            if (msg == null) return;

            string cmd = msg;
            string arg = "";
            int i = msg.IndexOf(':');
            if (i >= 0) { cmd = msg.Substring(0, i); arg = msg.Substring(i + 1); }

            switch (cmd)
            {
                case "ready":
                    pageReady = true;
                    Send("cfg:pin=" + (pinned ? "1" : "0") + ";op=" + Opacity.ToString("0.##", CultureInfo.InvariantCulture));
                    if (startText != null) Send("url:" + startText);
                    lastMove = Environment.TickCount;
                    hoverTimer.Start();
                    StartUpdateChecks();
                    break;
                case "drag": BeginGesture("move"); break;
                case "size": BeginGesture(arg); break;
                case "min": WindowState = FormWindowState.Minimized; break;
                case "close": Close(); break;
                case "pin":
                    pinned = arg == "1";
                    if (!fullscreen) TopMost = pinned;
                    break;
                case "op":
                    double v;
                    if (double.TryParse(arg, NumberStyles.Float, CultureInfo.InvariantCulture, out v))
                        Opacity = Math.Max(0.25, Math.Min(1.0, v));
                    break;
                case "paste": Send("url:" + ReadClipboard()); break;
                case "typing": typing = arg == "1"; break;
                case "open": OpenExternal(arg); break;
                case "mod":                                                 // abre um modulo (youtube, spotify) ou volta ao player
                    if (arg == "player") HideModules(); else RunModule(arg, null);
                    break;
                case "search":                                              // pesquisa no YouTube
                    if (arg.Length > 0 && arg.Length <= 300)
                        RunModule("youtube", "https://m.youtube.com/results?search_query=" + Uri.EscapeDataString(arg));
                    break;
                case "modhome":
                    if (activeModule != null && activeModule.Core != null)
                    {
                        try { activeModule.Core.Navigate(activeModule.HomeUrl); } catch { }
                    }
                    break;
                case "update": ApplyUpdateNow(arg); break;                 // "Atualizar": troca os arquivos e abre a versao nova
                case "updweb": OpenExternal(updatePage); break;            // "Baixar": abre a pagina do release no navegador
            }
        }

        // Ctrl+V e Ctrl+L tambem funcionam com o foco dentro do video (iframe do YouTube)
        void OnAccelerator(object sender, CoreWebView2AcceleratorKeyPressedEventArgs e)
        {
            if (e.KeyEventKind != CoreWebView2KeyEventKind.KeyDown) return;
            if ((Native.GetAsyncKeyState(0x11) & 0x8000) == 0) return;      // Ctrl
            if ((Native.GetAsyncKeyState(0x12) & 0x8000) != 0) return;      // Alt/AltGr: nao mexe
            if (typing) return;                                             // no campo de texto o colar e o normal

            if (e.VirtualKey == 0x56)                                       // V
            {
                e.Handled = true;
                Send("url:" + ReadClipboard());
            }
            else if (e.VirtualKey == 0x4C)                                  // L
            {
                e.Handled = true;
                Send("link");
            }
        }

        // ---------- modulos: busca do YouTube e Spotify (janela por baixo da barra) ----------

        float CurrentScale()
        {
            try { using (Graphics g = Graphics.FromHwnd(Handle)) return g.DpiX / 96f; }
            catch { return DpiScale(); }
        }

        Rectangle ModuleBounds()
        {
            float s = CurrentScale();
            int edge = (int)Math.Round(BrowseEdgeDip * s);
            int top = (int)Math.Round(BrowseBarDip * s);
            Size view = ViewSize();
            return new Rectangle(edge, top, Math.Max(1, view.Width - 2 * edge), Math.Max(1, view.Height - top - edge));
        }

        async void RunModule(string name, string url)
        {
            try { await ShowModule(name, url); }
            catch (Exception ex) { AppLog.Error(ex); Send("modfail:" + name); }
        }

        async Task ShowModule(string name, string url)
        {
            BrowseModule m;
            if (!modules.TryGetValue(name, out m)) return;
            int my = ++modSeq;
            if (m.Controller == null)
            {
                if (m.CreateTask == null) m.CreateTask = CreateModule(m);
                await m.CreateTask;
                if (my != modSeq) return;                  // o usuario ja voltou ao player ou escolheu outro modulo
            }
            foreach (BrowseModule o in modules.Values)
                if (o != m && o.Controller != null) o.Controller.IsVisible = false;
            activeModule = m;
            FitController();
            if (url != null) m.Core.Navigate(url);
            else if (string.IsNullOrEmpty(m.Core.Source) || m.Core.Source == "about:blank") m.Core.Navigate(m.HomeUrl);
            try { m.Controller.MoveFocus(CoreWebView2MoveFocusReason.Programmatic); } catch { }
            Send("mod:" + m.Name);
        }

        void HideModules()
        {
            modSeq++;
            foreach (BrowseModule o in modules.Values)
            {
                if (o.Controller != null) { try { o.Controller.IsVisible = false; } catch { } }
            }
            activeModule = null;
            FitController();
            if (controller != null) { try { controller.MoveFocus(CoreWebView2MoveFocusReason.Programmatic); } catch { } }
            Send("mod:player");
        }

        async Task CreateModule(BrowseModule m)
        {
            CoreWebView2Controller c = await env.CreateCoreWebView2ControllerAsync(Handle);
            CoreWebView2 w = c.CoreWebView2;
            c.DefaultBackgroundColor = Color.FromArgb(14, 14, 20);
            c.IsVisible = false;
            c.Bounds = ModuleBounds();

            CoreWebView2Settings st = w.Settings;
            st.AreDefaultContextMenusEnabled = false;
            st.AreDevToolsEnabled = false;
            st.IsStatusBarEnabled = false;
            st.IsZoomControlEnabled = false;
            st.IsPasswordAutosaveEnabled = false;          // o programa nao guarda senha nenhuma
            st.IsGeneralAutofillEnabled = false;
            try { w.IsMuted = m.Muted; } catch { }

            if (!string.IsNullOrEmpty(m.ScriptFile))
            {
                string path = Path.Combine(webDir, m.ScriptFile);
                if (File.Exists(path))
                {
                    try { await w.AddScriptToExecuteOnDocumentCreatedAsync(File.ReadAllText(path, System.Text.Encoding.UTF8)); }
                    catch (Exception ex) { AppLog.Error(ex); }
                }
            }

            w.WebMessageReceived += delegate(object s, CoreWebView2WebMessageReceivedEventArgs e) { OnModuleMessage(m, e); };
            w.NavigationStarting += delegate(object s, CoreWebView2NavigationStartingEventArgs e)
            {
                if (!HostAllowed(m, e.Uri)) { e.Cancel = true; OpenExternal(e.Uri); }
            };
            w.NewWindowRequested += delegate(object s, CoreWebView2NewWindowRequestedEventArgs e)
            {
                e.Handled = true;
                if (m.Name == "youtube" && WatchUrl.IsMatch(e.Uri)) PlayFromModule(e.Uri); else OpenExternal(e.Uri);
            };
            w.SourceChanged += delegate { OnModuleSourceChanged(m); };
            w.DocumentTitleChanged += delegate { if (m == activeModule) Send("modtitle:" + w.DocumentTitle); };
            w.PermissionRequested += delegate(object s, CoreWebView2PermissionRequestedEventArgs e) { e.State = CoreWebView2PermissionState.Deny; };
            w.ProcessFailed += delegate(object s, CoreWebView2ProcessFailedEventArgs e)
            {
                if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited ||
                    e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessUnresponsive)
                {
                    try { w.Reload(); } catch { }
                }
            };
            c.AcceleratorKeyPressed += OnModuleAccelerator;

            m.Core = w;
            m.Controller = c;
        }

        // so https e so os dominios do modulo na janela principal; o resto abre no navegador padrao
        static bool HostAllowed(BrowseModule m, string uri)
        {
            if (string.Equals(uri, "about:blank", StringComparison.OrdinalIgnoreCase)) return true;
            Uri u;
            if (!Uri.TryCreate(uri, UriKind.Absolute, out u)) return false;
            if (u.Scheme != Uri.UriSchemeHttps) return false;
            string h = u.Host.ToLowerInvariant();
            foreach (string s in m.AllowedHosts)
            {
                if (h == s || h.EndsWith("." + s)) return true;
            }
            return false;
        }

        // a busca do YouTube manda "lmmp-play:<link>" quando o usuario clica num video (script yt-browse.js)
        void OnModuleMessage(BrowseModule m, CoreWebView2WebMessageReceivedEventArgs e)
        {
            if (m.Name != "youtube" || !HostAllowed(m, e.Source ?? "")) return;
            string msg;
            try { msg = e.TryGetWebMessageAsString(); } catch { return; }
            if (msg != null && msg.StartsWith("lmmp-play:", StringComparison.Ordinal)) PlayFromModule(msg.Substring(10));
        }

        // o link escolhido na busca toca no NOSSO player (com velocidade livre, atalhos etc.)
        void PlayFromModule(string url)
        {
            if (url == null || url.Length > 600 || !WatchUrl.IsMatch(url)) return;
            HideModules();
            Send("url:" + url);
        }

        // rede de seguranca: se o site abriu o video sozinho (clique que o script nao pegou), para ali e toca no nosso player
        void OnModuleSourceChanged(BrowseModule m)
        {
            if (m.Name != "youtube" || m.Core == null) return;
            string src = m.Core.Source ?? "";
            if (!WatchUrl.IsMatch(src)) return;
            try { m.Core.ExecuteScriptAsync("document.querySelectorAll('video').forEach(function (v) { v.pause(); })"); } catch { }
            try { if (m.Core.CanGoBack) m.Core.GoBack(); } catch { }
            PlayFromModule(src);
        }

        // Ctrl+L dentro de um modulo leva para a barra de busca do programa
        void OnModuleAccelerator(object sender, CoreWebView2AcceleratorKeyPressedEventArgs e)
        {
            if (e.KeyEventKind != CoreWebView2KeyEventKind.KeyDown) return;
            if ((Native.GetAsyncKeyState(0x11) & 0x8000) == 0) return;      // Ctrl
            if ((Native.GetAsyncKeyState(0x12) & 0x8000) != 0) return;      // Alt/AltGr: nao mexe
            if (e.VirtualKey == 0x4C)                                       // L
            {
                e.Handled = true;
                try { controller.MoveFocus(CoreWebView2MoveFocusReason.Programmatic); } catch { }
                Send("link");
            }
        }

        // o botao de tela cheia do YouTube: a janela vira a tela inteira e volta ao tamanho de antes
        void OnFullScreenChanged(object sender, object e)
        {
            bool want = core.ContainsFullScreenElement;
            if (want == fullscreen) return;
            fullscreen = want;
            if (want)
            {
                boundsBeforeFull = Bounds;
                TopMost = true;
                Bounds = Screen.FromControl(this).Bounds;
            }
            else
            {
                Bounds = boundsBeforeFull;
                TopMost = pinned;
            }
        }

        void OnProcessFailed(object sender, CoreWebView2ProcessFailedEventArgs e)
        {
            switch (e.ProcessFailedKind)
            {
                case CoreWebView2ProcessFailedKind.BrowserProcessExited:
                    Close();
                    break;
                case CoreWebView2ProcessFailedKind.RenderProcessExited:
                case CoreWebView2ProcessFailedKind.RenderProcessUnresponsive:
                    try { core.Reload(); } catch { }
                    break;
            }
        }

        // ---------- mover e redimensionar (sem borda do Windows) ----------

        void BeginGesture(string mode)
        {
            if (fullscreen || WindowState != FormWindowState.Normal) return;
            if (!IsValidGesture(mode)) return;
            gesture = mode;
            gestureCursor = Cursor.Position;
            gestureBounds = Bounds;
            gestureTimer.Start();
        }

        static bool IsValidGesture(string m)
        {
            switch (m)
            {
                case "move": case "n": case "s": case "e": case "w":
                case "ne": case "nw": case "se": case "sw":
                    return true;
            }
            return false;
        }

        // botao esquerdo do mouse (o fisico; troca de botoes por canhoto e considerada)
        static bool PrimaryButtonDown()
        {
            int vk = Native.GetSystemMetrics(23) != 0 ? 0x02 : 0x01;      // SM_SWAPBUTTON
            return (Native.GetAsyncKeyState(vk) & 0x8000) != 0;
        }

        void OnGestureTick(object sender, EventArgs e)
        {
            if (gesture == null) { gestureTimer.Stop(); return; }
            if (!PrimaryButtonDown()) { EndGesture(); return; }

            Point c = Cursor.Position;
            int dx = c.X - gestureCursor.X;
            int dy = c.Y - gestureCursor.Y;
            int l = gestureBounds.Left, t = gestureBounds.Top, r = gestureBounds.Right, b = gestureBounds.Bottom;
            int minW = MinimumSize.Width, minH = MinimumSize.Height;

            if (gesture == "move")
            {
                l += dx; r += dx; t += dy; b += dy;
            }
            else
            {
                if (gesture.IndexOf('w') >= 0) l = Math.Min(l + dx, r - minW);
                if (gesture.IndexOf('e') >= 0) r = Math.Max(r + dx, l + minW);
                if (gesture.IndexOf('n') >= 0) t = Math.Min(t + dy, b - minH);
                if (gesture.IndexOf('s') >= 0) b = Math.Max(b + dy, t + minH);
            }

            Rectangle nb = Rectangle.FromLTRB(l, t, r, b);
            if (nb != Bounds) Bounds = nb;
        }

        void EndGesture()
        {
            gesture = null;
            gestureTimer.Stop();
            Send("dragend");
            SaveSettings();
        }

        // ---------- barra de cima: aparece quando o mouse mexe sobre a janela ----------

        void OnHoverTick(object sender, EventArgs e)
        {
            if (!pageReady) return;

            Point c = Cursor.Position;
            if (c != lastCursor) { lastCursor = c; lastMove = Environment.TickCount; }

            bool inside = Visible && WindowState != FormWindowState.Minimized && Bounds.Contains(c) && OwnsPointAt(c);
            bool recent = unchecked(Environment.TickCount - lastMove) < IdleHideMs;
            bool active = gesture != null || (inside && recent);

            if (active != lastActive)
            {
                lastActive = active;
                Send(active ? "ui:1" : "ui:0");
            }
        }

        // o ponto esta sobre a nossa janela (e nao sobre outra janela que esteja na frente)?
        bool OwnsPointAt(Point p)
        {
            try
            {
                Native.POINT np; np.X = p.X; np.Y = p.Y;
                IntPtr h = Native.WindowFromPoint(np);
                if (h == IntPtr.Zero) return false;
                return Native.GetAncestor(h, 2) == Handle;                  // GA_ROOT
            }
            catch { return true; }
        }

        // ---------- atualizacao automatica ----------

        // depois que a pagina abre: confere se ha versao nova (agora e de tempos em tempos)
        void StartUpdateChecks()
        {
            if (updateStarted) { SendUpdateState(); return; }       // a pagina recarregou: mostra o aviso de novo
            updateStarted = true;

            // limpa o que uma troca anterior deixou (os arquivos antigos so podem sair depois que o processo velho fechar)
            bool justUpdated = Updater.JustUpdated;
            System.Threading.ThreadPool.QueueUserWorkItem(delegate
            {
                for (int i = 0; i < (justUpdated ? 12 : 1); i++)
                {
                    System.Threading.Thread.Sleep(5000);
                    if (Updater.Cleanup()) break;
                }
            });

            if (!Updater.Enabled(cfg)) return;
            Timer first = new Timer();
            first.Interval = 4000;                                  // deixa o video e a tela subirem antes
            first.Tick += delegate { first.Stop(); first.Dispose(); RunUpdateCheck(); };
            first.Start();
            updateTimer.Interval = UpdateEveryMs;
            updateTimer.Tick += delegate { RunUpdateCheck(); };
            updateTimer.Start();
        }

        void SendUpdateState()
        {
            if (updateVersion == null) return;
            Send("upd:" + (updateReady ? "ready:" : "manual:") + updateVersion.ToString(3));
        }

        async void RunUpdateCheck()
        {
            if (!Updater.Enabled(cfg) || updateBusy || updateReady) return;
            updateBusy = true;
            try
            {
                // uma versao baixada numa vez anterior ja esta esperando?
                StagedUpdate staged = Updater.FindStaged();
                if (staged != null) { updateVersion = staged.Version; updateReady = true; SendUpdateState(); }

                UpdateInfo info = await Task.Run(() => Updater.CheckLatest());
                if (info == null) return;
                updatePage = info.PageUrl;
                if (staged != null && staged.Version >= info.Version) return;

                // sem como instalar sozinho (pasta sem permissao, release sem SHA-256): avisa e deixa baixar no site
                if (!info.CanInstall || !Updater.CanWrite())
                {
                    updateVersion = info.Version;
                    updateReady = false;
                    SendUpdateState();
                    return;
                }

                staged = await Task.Run(() => Updater.Stage(info));
                updateVersion = staged.Version;
                updateReady = true;
                SendUpdateState();
            }
            catch (System.Net.WebException) { /* sem internet ou GitHub fora do ar: tenta na proxima vez */ }
            catch (Exception ex) { AppLog.Error(ex); }
            finally { updateBusy = false; }
        }

        // o usuario clicou em "Atualizar": troca os arquivos, abre a versao nova (no mesmo video) e fecha esta janela
        async void ApplyUpdateNow(string link)
        {
            if (updateBusy || !updateReady) return;
            StagedUpdate st = Updater.FindStaged();
            if (st == null) { updateReady = false; Send("upd:fail"); return; }

            updateBusy = true;
            Send("upd:busy");
            bool ok = false;
            try
            {
                SaveSettings();                                     // a janela nova abre no mesmo lugar e tamanho
                List<string> extra = new List<string>();
                if (startMinimized) extra.Add("--minimized");
                if (!string.IsNullOrEmpty(link) && link.Length <= 300 && ResumeLink.IsMatch(link)) extra.Add(link);   // volta ao mesmo video
                string extraArgs = Updater.JoinArgs(extra.ToArray());
                ok = await Task.Run(() => Updater.ApplyAndRelaunch(st, extraArgs));
            }
            catch (Exception ex) { AppLog.Error(ex); }

            if (ok) { Close(); return; }

            updateBusy = false;
            updateReady = false;
            Updater.MarkFailed(st);
            Send("upd:fail");
        }

        // ---------- utilidades ----------

        static string StartLink(string[] args)
        {
            if (args != null && args.Length > 0)
            {
                string joined = string.Join(" ", args).Trim();
                if (joined.Length > 0) return joined;
            }
            // sem argumento: se ja ha um link do YouTube copiado, toca direto
            string clip = ReadClipboard();
            if (Regex.IsMatch(clip, @"(?i)\b(youtu\.be|youtube\.com|youtube-nocookie\.com)/")) return clip;
            return null;
        }

        static string ReadClipboard()
        {
            for (int i = 0; i < 4; i++)
            {
                try
                {
                    if (!Clipboard.ContainsText()) return "";
                    string t = Clipboard.GetText() ?? "";
                    return t.Length > 4000 ? t.Substring(0, 4000) : t;
                }
                catch (ExternalException) { System.Threading.Thread.Sleep(40); }   // area de transferencia ocupada
                catch (Exception) { return ""; }
            }
            return "";
        }

        static void OpenExternal(string url)
        {
            Uri u;
            if (!Uri.TryCreate(url, UriKind.Absolute, out u)) return;
            if (u.Scheme != Uri.UriSchemeHttp && u.Scheme != Uri.UriSchemeHttps) return;
            try { Process.Start(new ProcessStartInfo(u.AbsoluteUri) { UseShellExecute = true }); } catch { }
        }
    }
}
