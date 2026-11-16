// LM Mini Player - transparencia e "modo fantasma".
//
// A janela pode ficar de 10% a 100% visivel (barra de transparencia no menu ≡). Ate 50% ela vira "fantasma": para o
// usuario nao perder a janela nem ter a janela aparecendo toda hora, so uma ALCA pequena (o botao ≡) fica a vista no
// canto de cima. Passar o mouse na alca mostra a janela inteira enquanto o mouse estiver sobre ela (some de novo
// quando o mouse sai ou fica parado). Enquanto houver uma tela do programa por cima do video (menu, sala, pesquisa,
// Spotify, erro, janela vazia) a janela tambem aparece inteira: so fica transparente enquanto voce assiste.
//
// A alca e uma janela propria (dona: a janela principal) e nao muda com a transparencia da principal.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace LMMiniPlayer
{
    // O quadradinho do canto: um botao ≡ desenhado com transparencia por pixel (cantos suaves), que nao rouba o foco.
    sealed class GhostHandle : Form
    {
        const int WS_EX_LAYERED = 0x00080000;
        const int WS_EX_TOOLWINDOW = 0x00000080;
        const int WS_EX_NOACTIVATE = 0x08000000;
        const int ULW_ALPHA = 2;

        [StructLayout(LayoutKind.Sequential)] struct PT { public int x, y; }
        [StructLayout(LayoutKind.Sequential)] struct SZ { public int cx, cy; }
        [StructLayout(LayoutKind.Sequential, Pack = 1)] struct BLEND { public byte BlendOp, BlendFlags, SourceConstantAlpha, AlphaFormat; }

        [DllImport("user32.dll", SetLastError = true)]
        static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr hdcDst, IntPtr pptDst, ref SZ psize, IntPtr hdcSrc, ref PT pptSrc, int crKey, ref BLEND pblend, int dwFlags);
        [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hwnd);
        [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);
        [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr hdc);
        [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr hdc);
        [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
        [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);

        readonly int side;                                              // lado em pixels
        readonly float scale;
        bool hover;
        public bool LastRenderOk;                                       // o Windows aceitou o ultimo desenho? (para testes)
        public int LastRenderError;

        public event EventHandler Clicked;
        public event EventHandler HoverChanged;

        public bool Hover { get { return hover; } }

        public GhostHandle(int sidePx, float dpiScale)
        {
            side = Math.Max(24, sidePx);
            scale = dpiScale;
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            Cursor = Cursors.Hand;
            Text = "LM Mini Player (alça)";
            ClientSize = new Size(side, side);
        }

        protected override bool ShowWithoutActivation { get { return true; } }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
                return cp;
            }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            Render();
        }

        protected override void OnVisibleChanged(EventArgs e)
        {
            base.OnVisibleChanged(e);
            if (!Visible) hover = false;                                // escondida com o mouse em cima: nao ha "saiu"; volta sem o realce
            if (Visible && IsHandleCreated) Render();
        }

        protected override void OnPaintBackground(PaintEventArgs e) { }      // o que aparece e o desenho entregue ao Windows em Render(), nao o fundo do formulario

        protected override void OnMouseEnter(EventArgs e)
        {
            base.OnMouseEnter(e);
            hover = true;
            Render();
            if (HoverChanged != null) HoverChanged(this, EventArgs.Empty);
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            base.OnMouseLeave(e);
            hover = false;
            Render();
            if (HoverChanged != null) HoverChanged(this, EventArgs.Empty);
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            if (e.Button == MouseButtons.Left && Clicked != null) Clicked(this, EventArgs.Empty);
        }

        // desenho do botao (cantos arredondados + 3 tracos), com ou sem o realce do mouse
        public Bitmap Draw(bool hot)
        {
            Bitmap bmp = new Bitmap(side, side, PixelFormat.Format32bppPArgb);
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.Clear(Color.Transparent);
                float r = 10f * scale;
                RectangleF box = new RectangleF(0.5f, 0.5f, side - 1f, side - 1f);
                using (GraphicsPath p = Round(box, r))
                using (SolidBrush fill = new SolidBrush(hot ? Color.FromArgb(246, 52, 52, 66) : Color.FromArgb(240, 20, 20, 27)))
                using (Pen edge = new Pen(Color.FromArgb(hot ? 150 : 100, 255, 255, 255), Math.Max(1f, scale)))
                {
                    g.FillPath(fill, p);
                    g.DrawPath(edge, p);
                }
                using (Pen line = new Pen(Color.FromArgb(250, 255, 255, 255), 2f * scale))
                {
                    line.StartCap = LineCap.Round;
                    line.EndCap = LineCap.Round;
                    float cx = side / 2f, cy = side / 2f, half = 6f * scale, gap = 5f * scale;
                    g.DrawLine(line, cx - half, cy - gap, cx + half, cy - gap);
                    g.DrawLine(line, cx - half, cy, cx + half, cy);
                    g.DrawLine(line, cx - half, cy + gap, cx + half, cy + gap);
                }
            }
            return bmp;
        }

        static GraphicsPath Round(RectangleF b, float r)
        {
            GraphicsPath p = new GraphicsPath();
            float d = r * 2f;
            p.AddArc(b.Left, b.Top, d, d, 180, 90);
            p.AddArc(b.Right - d, b.Top, d, d, 270, 90);
            p.AddArc(b.Right - d, b.Bottom - d, d, d, 0, 90);
            p.AddArc(b.Left, b.Bottom - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }

        // entrega o desenho ao Windows (janela com transparencia por pixel)
        public void Render()
        {
            if (!IsHandleCreated) return;
            IntPtr screenDc = IntPtr.Zero, memDc = IntPtr.Zero, hBmp = IntPtr.Zero, old = IntPtr.Zero;
            try
            {
                using (Bitmap bmp = Draw(hover))
                {
                    screenDc = GetDC(IntPtr.Zero);
                    memDc = CreateCompatibleDC(screenDc);
                    hBmp = bmp.GetHbitmap(Color.FromArgb(0));
                    old = SelectObject(memDc, hBmp);
                    SZ size; size.cx = side; size.cy = side;
                    PT src; src.x = 0; src.y = 0;
                    BLEND blend; blend.BlendOp = 0; blend.BlendFlags = 0; blend.SourceConstantAlpha = 255; blend.AlphaFormat = 1;   // AC_SRC_OVER, AC_SRC_ALPHA
                    LastRenderOk = UpdateLayeredWindow(Handle, screenDc, IntPtr.Zero, ref size, memDc, ref src, 0, ref blend, ULW_ALPHA);
                    LastRenderError = LastRenderOk ? 0 : Marshal.GetLastWin32Error();
                }
            }
            catch (Exception ex) { AppLog.Error(ex); }
            finally
            {
                if (memDc != IntPtr.Zero && old != IntPtr.Zero) SelectObject(memDc, old);
                if (hBmp != IntPtr.Zero) DeleteObject(hBmp);
                if (memDc != IntPtr.Zero) DeleteDC(memDc);
                if (screenDc != IntPtr.Zero) ReleaseDC(IntPtr.Zero, screenDc);
            }
        }
    }

    sealed partial class MainForm
    {
        // ---------- transparencia: o que o usuario escolheu, o que a janela mostra agora e o modo fantasma ----------

        public const double MinOpacity = 0.10;                          // a barra de transparencia vai de 10% a 100%
        const double GhostMax = 0.50;                                   // ate aqui a janela vira "fantasma" (igual a GHOST_MAX em app.js)
        const int PreviewMs = 700;                                      // depois de mexer na barra, a janela mostra o efeito por este tempo
        const int RevealIdleMs = 3000;                                  // revelada, volta a ser fantasma depois de tanto tempo com o mouse parado
        const int LeaveGraceMs = 350;                                   // o mouse pode sair da janela por tanto tempo sem esconder
        const int MenuLeaveCloseMs = 1200;                              // menu aberto com o mouse fora da janela (fantasma): o menu fecha

        double userOpacity = 1.0;                                       // a transparencia escolhida (gravada em config.ini)
        double target = 1.0;                                            // para onde a janela caminha agora
        readonly Timer fadeTimer = new Timer();
        bool overlay;                                                   // a pagina mostra uma tela por cima do video (menu, sala, pesquisa...)
        bool menuOpen;
        bool sliderDrag;                                                // a barra de transparencia esta sendo arrastada
        int previewAt;                                                  // TickCount do ultimo ajuste da barra
        bool previewSet;
        bool ghostRevealed;                                             // o mouse passou pela alca: a janela fica inteira enquanto ele estiver por ali
        bool outsideSet;                                                // o mouse esta fora da janela (revelada) desde outsideAt
        int outsideAt;
        bool menuOutsideSet;                                            // menu aberto e o mouse fora da janela desde menuOutsideAt
        int menuOutsideAt;
        bool menuCloseSent;
        bool settingsDirty;                                             // a transparencia mudou e ainda nao foi gravada
        GhostHandle handle;
        float handleScale;                                              // a escala de tela com que a alca foi desenhada
        BrowseModule menuHidModule;                                     // o site que o menu escondeu para aparecer por cima (volta quando o menu fecha)
        Point? testCursor;                                              // so para testes (LMMP_TEST=1): mouse virtual
        readonly bool testMode = Environment.GetEnvironmentVariable("LMMP_TEST") == "1";

        bool IsGhost { get { return userOpacity <= GhostMax + 1e-9; } }

        static int Since(int then) { return unchecked(Environment.TickCount - then); }

        bool Previewing(int now)
        {
            return sliderDrag || (previewSet && unchecked(now - previewAt) < PreviewMs);
        }

        // a janela esta inteira a vista agora? (fantasma revelado, tela por cima do video...)
        bool GhostShown(int now)
        {
            return !IsGhost || !pageReady || fullscreen || overlay || ghostRevealed || gesture != null;
        }

        double ComputeTarget(int now)
        {
            if (!IsGhost || Previewing(now)) return userOpacity;
            return GhostShown(now) ? 1.0 : userOpacity;
        }

        // muda o alvo da transparencia; "snap" = na hora (ajuste da barra), senao esmaece
        void ApplyOpacity(int now, bool snap)
        {
            target = ComputeTarget(now);
            if (snap) { fadeTimer.Stop(); SetShown(target); return; }
            if (Math.Abs(Opacity - target) > 0.004) { if (!fadeTimer.Enabled) fadeTimer.Start(); }
            else SetShown(target);
        }

        void SetShown(double v)
        {
            v = Math.Max(0.0, Math.Min(1.0, v));
            if (Math.Abs(Opacity - v) > 1e-9) Opacity = v;
        }

        void OnFade(object sender, EventArgs e)
        {
            double d = target - Opacity;
            if (Math.Abs(d) < 0.004) { SetShown(target); fadeTimer.Stop(); return; }
            double step = 0.16;
            SetShown(Opacity + Math.Max(-step, Math.Min(step, d)));
        }

        // a pagina pediu esta transparencia (barra do menu)
        void SetUserOpacity(double v, int now)
        {
            userOpacity = Math.Max(MinOpacity, Math.Min(1.0, v));
            previewAt = now;
            previewSet = true;
            settingsDirty = true;
            ApplyOpacity(now, true);
        }

        // o menu abriu ou fechou: por cima de um site (Spotify, YouTube) so aparece se o site sair da frente
        void OnMenuState(bool open)
        {
            menuOpen = open;
            menuCloseSent = false;
            if (open)
            {
                if (activeModule != null && activeModule.Controller != null)
                {
                    menuHidModule = activeModule;
                    try { activeModule.Controller.IsVisible = false; } catch { }
                }
            }
            else if (menuHidModule != null)
            {
                menuHidModule = null;
                FitController();                                        // mostra o site de novo (e traz para cima)
            }
        }

        // a cada 100 ms: revela ou esconde o fantasma, mostra ou esconde a alca, esmaece, fecha o menu esquecido
        void GhostTick(int now, bool inside, bool onHandle)
        {
            if (!IsGhost) ghostRevealed = false;
            else if (onHandle) { ghostRevealed = true; outsideSet = false; }
            else if (ghostRevealed && gesture == null)
            {
                if (!inside)
                {
                    if (!outsideSet) { outsideSet = true; outsideAt = now; }
                    else if (unchecked(now - outsideAt) > LeaveGraceMs) { ghostRevealed = false; outsideSet = false; }
                }
                else
                {
                    outsideSet = false;
                    if (Since(lastMove) >= RevealIdleMs) ghostRevealed = false;      // parado: volta a ser fantasma
                }
            }

            // menu esquecido aberto com o mouse longe (so no fantasma, onde ele mantem a janela inteira a vista)
            if (menuOpen && IsGhost && !inside && !sliderDrag)           // (arrastando a barra o mouse pode passar da janela: nao fecha)
            {
                if (!menuOutsideSet) { menuOutsideSet = true; menuOutsideAt = now; }
                else if (!menuCloseSent && unchecked(now - menuOutsideAt) > MenuLeaveCloseMs) { menuCloseSent = true; Send("menu:close"); }
            }
            else menuOutsideSet = false;

            if (settingsDirty && !sliderDrag && !Previewing(now)) { settingsDirty = false; SaveSettings(); }

            ApplyOpacity(now, false);
            UpdateHandle(now, onHandle);
        }

        // a alca aparece so no fantasma, com a janela apagada (ou com o mouse em cima dela)
        void UpdateHandle(int now, bool onHandle)
        {
            bool want = IsGhost && pageReady && Visible && WindowState == FormWindowState.Normal && !fullscreen && !overlay && !Previewing(now) &&
                        (!ghostRevealed || onHandle);
            if (want)
            {
                float sc = CurrentScale();
                if (handle != null && Math.Abs(handleScale - sc) > 0.01f) { try { handle.Close(); } catch { } handle = null; }   // a janela mudou de tela com outra escala
                if (handle == null)
                {
                    float s = sc;
                    handleScale = s;
                    handle = new GhostHandle((int)Math.Round(32 * s), s);
                    handle.Owner = this;
                    handle.Clicked += delegate { Send("menu:toggle"); };
                    handle.HoverChanged += delegate { BeginInvoke(new MethodInvoker(delegate { OnHoverTick(null, EventArgs.Empty); })); };
                }
                PlaceHandle();
                if (handle.TopMost != TopMost) handle.TopMost = TopMost;
                if (!handle.Visible) handle.Show();
            }
            else if (handle != null && handle.Visible) handle.Hide();
        }

        // no canto de cima da janela, onde fica o botao ≡ da barra
        void PlaceHandle()
        {
            if (handle == null) return;
            float s = CurrentScale();
            Point p = new Point(Left + (int)Math.Round(8 * s), Top + (int)Math.Round(8 * s));
            if (handle.Location != p) handle.Location = p;
        }

        // ---------- so para testes (LMMP_TEST=1): mouse virtual, retrato do estado e janela fora da tela ----------

        // LMMP_TEST_BOUNDS="x,y,w,h": a janela ja nasce nesse lugar (ex.: fora de qualquer tela), sem nunca aparecer para o usuario
        void TestBounds()
        {
            string v = Environment.GetEnvironmentVariable("LMMP_TEST_BOUNDS");
            if (string.IsNullOrEmpty(v)) return;
            string[] a = v.Split(',');
            int x, y, w, h;
            if (a.Length == 4 && int.TryParse(a[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out x) && int.TryParse(a[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out y) &&
                int.TryParse(a[2], NumberStyles.Integer, CultureInfo.InvariantCulture, out w) && int.TryParse(a[3], NumberStyles.Integer, CultureInfo.InvariantCulture, out h))
                Bounds = new Rectangle(x, y, w, h);
        }

        void HandleDebug(string arg)
        {
            if (!testMode) return;
            if (arg.StartsWith("cursor:", StringComparison.Ordinal))
            {
                string v = arg.Substring(7);
                if (v == "off") { testCursor = null; return; }
                string[] xy = v.Split(',');
                int x, y;
                if (xy.Length == 2 && int.TryParse(xy[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out x) && int.TryParse(xy[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out y))
                    testCursor = new Point(x, y);
            }
            else if (arg == "show")                                              // sai do minimizado SEM ativar (SW_SHOWNOACTIVATE): nao tira o foco de ninguem
            {
                Native.ShowWindow(Handle, 4);
            }
            else if (arg == "state")
            {
                Rectangle hb = handle != null && handle.Visible ? handle.Bounds : Rectangle.Empty;
                Rectangle rb = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;     // (minimizada, o que vale e onde ela volta)
                Send("dbg:" + new JavaScriptSerializer().Serialize(new Dictionary<string, object>
                {
                    { "user", userOpacity }, { "shown", Opacity }, { "target", target }, { "ghost", IsGhost }, { "reveal", ghostRevealed },
                    { "overlay", overlay }, { "menu", menuOpen }, { "drag", sliderDrag }, { "dirty", settingsDirty }, { "previewing", Previewing(Environment.TickCount) },
                    { "handle", handle != null && handle.Visible }, { "hrender", handle != null && handle.LastRenderOk }, { "herr", handle == null ? 0 : handle.LastRenderError }, { "hx", hb.X }, { "hy", hb.Y }, { "hw", hb.Width }, { "hh", hb.Height },
                    { "x", rb.X }, { "y", rb.Y }, { "w", rb.Width }, { "h", rb.Height }, { "state", WindowState.ToString() },
                    { "tbhr", thumb == null ? 0 : thumb.LastHr }, { "tbn", thumb == null ? 0 : thumb.Updates }
                }));
            }
            else if (arg.StartsWith("handleicon:", StringComparison.Ordinal))      // grava o desenho da alca em png (para olhar como ficou)
            {
                try
                {
                    using (GhostHandle h = new GhostHandle((int)Math.Round(32 * CurrentScale()), CurrentScale()))
                    {
                        Directory.CreateDirectory(AppPaths.DataDir);
                        using (Bitmap b = h.Draw(false)) b.Save(Path.Combine(AppPaths.DataDir, "handle.png"), ImageFormat.Png);
                        using (Bitmap b = h.Draw(true)) b.Save(Path.Combine(AppPaths.DataDir, "handle-hot.png"), ImageFormat.Png);
                    }
                }
                catch (Exception ex) { AppLog.Error(ex); }
            }
        }
    }
}
