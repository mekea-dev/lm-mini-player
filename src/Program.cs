// LM Mini Player - janela flutuante (sempre por cima) que toca videos do YouTube.
//
// A janela e so uma "moldura": o video e a interface vivem em web\ (HTML/CSS/JS) e rodam
// dentro do WebView2 (o motor do Edge que ja vem no Windows). Este arquivo cuida do que a
// pagina nao consegue: ficar por cima de tudo, mover/redimensionar sem borda, transparencia,
// tela cheia, lembrar posicao e tamanho, e o Ctrl+V com o foco dentro do video.
//
// Compila com o csc.exe que ja vem no Windows (C# 5): veja build.ps1.
using System;
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
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

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
        public static string DataDir
        {
            get
            {
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

    // posicao, tamanho, "sempre por cima" e transparencia, gravados em config.ini
    sealed class Settings
    {
        public int X = int.MinValue;
        public int Y = int.MinValue;
        public int W = 0;
        public int H = 0;
        public bool Pin = true;
        public double Opacity = 1.0;

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
                    "opacity=" + Opacity.ToString("0.##", CultureInfo.InvariantCulture)
                };
                File.WriteAllText(FilePath, string.Join("\r\n", lines) + "\r\n");
            }
            catch { /* sem permissao de escrita: so nao lembra da posicao */ }
        }
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

        public MainForm(string[] args)
        {
            cfg = Settings.Load();
            pinned = cfg.Pin;

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
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            startText = StartLink(args);

            hoverTimer.Interval = 100;
            hoverTimer.Tick += OnHoverTick;
            gestureTimer.Interval = 10;
            gestureTimer.Tick += OnGestureTick;

            SizeChanged += delegate { FitController(); };
            Activated += delegate
            {
                if (controller != null)
                {
                    try { controller.MoveFocus(CoreWebView2MoveFocusReason.Programmatic); } catch { }
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

        void FitController()
        {
            if (controller == null || WindowState == FormWindowState.Minimized) return;
            try
            {
                controller.Bounds = new Rectangle(0, 0, ClientSize.Width, ClientSize.Height);
                controller.IsVisible = true;
            }
            catch { }
        }

        // ---------- WebView2 ----------

        async Task InitWebView()
        {
            string webDir = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "web");
            if (!File.Exists(Path.Combine(webDir, "index.html")))
                throw new FileNotFoundException("A pasta \"web\" precisa ficar ao lado do LMMiniPlayer.exe.");

            var options = new CoreWebView2EnvironmentOptions();
            // sem isso o Chromium bloqueia o play automatico quando o video e colado por fora da pagina
            options.AdditionalBrowserArguments = "--autoplay-policy=no-user-gesture-required";

            CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(
                null, Path.Combine(AppPaths.DataDir, "WebView2"), options);
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
