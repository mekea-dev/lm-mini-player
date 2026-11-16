// LM Mini Player - botoes na miniatura da barra de tarefas (como o Spotify): anterior, play/pause, proxima,
// microfone, fone e volume. Usa a API do Windows ITaskbarList3 (nao precisa de biblioteca nenhuma).
//
// O programa so desenha os botoes e avisa qual foi clicado; quem sabe o que cada um faz e a pagina (web\app.js),
// que tambem manda o estado ("tbs:p=1;nx=0;mic=-1;hear=-1") para os icones e as dicas acompanharem o que esta acontecendo.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Win32;

namespace LMMiniPlayer
{
    [ComImport, Guid("56FDF344-FD6D-11d0-958A-006097C9A090"), ClassInterface(ClassInterfaceType.None)]
    class CTaskbarList { }

    // so a ordem dos metodos importa (e a tabela do COM); os que o programa nao usa ficam so para manter as posicoes
    [ComImport, Guid("EA1AFB91-9E28-4B86-90E9-9E9F8A5EEFAF"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ITaskbarList3
    {
        [PreserveSig] int HrInit();
        [PreserveSig] int AddTab(IntPtr hwnd);
        [PreserveSig] int DeleteTab(IntPtr hwnd);
        [PreserveSig] int ActivateTab(IntPtr hwnd);
        [PreserveSig] int SetActiveAlt(IntPtr hwnd);
        [PreserveSig] int MarkFullscreenWindow(IntPtr hwnd, [MarshalAs(UnmanagedType.Bool)] bool fFullscreen);
        [PreserveSig] int SetProgressValue(IntPtr hwnd, ulong ullCompleted, ulong ullTotal);
        [PreserveSig] int SetProgressState(IntPtr hwnd, int tbpFlags);
        [PreserveSig] int RegisterTab(IntPtr hwndTab, IntPtr hwndMDI);
        [PreserveSig] int UnregisterTab(IntPtr hwndTab);
        [PreserveSig] int SetTabOrder(IntPtr hwndTab, IntPtr hwndInsertBefore);
        [PreserveSig] int SetTabActive(IntPtr hwndTab, IntPtr hwndMDI, uint dwReserved);
        [PreserveSig] int ThumbBarAddButtons(IntPtr hwnd, uint cButtons, [MarshalAs(UnmanagedType.LPArray)] ThumbButton[] pButton);
        [PreserveSig] int ThumbBarUpdateButtons(IntPtr hwnd, uint cButtons, [MarshalAs(UnmanagedType.LPArray)] ThumbButton[] pButton);
        [PreserveSig] int ThumbBarSetImageList(IntPtr hwnd, IntPtr himl);
        [PreserveSig] int SetOverlayIcon(IntPtr hwnd, IntPtr hIcon, [MarshalAs(UnmanagedType.LPWStr)] string pszDescription);
        [PreserveSig] int SetThumbnailTooltip(IntPtr hwnd, [MarshalAs(UnmanagedType.LPWStr)] string pszTip);
        [PreserveSig] int SetThumbnailClip(IntPtr hwnd, IntPtr prcClip);
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode, Pack = 8)]
    struct ThumbButton
    {
        public uint dwMask;
        public uint iId;
        public uint iBitmap;
        public IntPtr hIcon;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szTip;
        public uint dwFlags;
    }

    // o que a pagina conta sobre o que esta acontecendo (veja tbState() em app.js)
    sealed class TbState
    {
        public int P = -1;          // -1 nada tocando, 0 parado, 1 tocando
        public int Nx;              // 1 = ha proximo video
        public int Mic = -1;        // -1 fora da voz, 0 nao entrou, 1 ligado, 2 mudo
        public int Hear = -1;       // -1 fora da voz, 1 ouvindo, 0 fone desligado

        public static TbState Parse(string s)
        {
            TbState t = new TbState();
            if (string.IsNullOrEmpty(s) || s.Length > 120) return t;
            foreach (string kv in s.Split(';'))
            {
                int i = kv.IndexOf('=');
                int n;
                if (i <= 0 || !int.TryParse(kv.Substring(i + 1), NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out n)) continue;
                switch (kv.Substring(0, i))
                {
                    case "p": t.P = Math.Max(-1, Math.Min(1, n)); break;
                    case "nx": t.Nx = n != 0 ? 1 : 0; break;
                    case "mic": t.Mic = Math.Max(-1, Math.Min(2, n)); break;
                    case "hear": t.Hear = Math.Max(-1, Math.Min(1, n)); break;
                }
            }
            return t;
        }

        public override string ToString() { return "p=" + P + ";nx=" + Nx + ";mic=" + Mic + ";hear=" + Hear; }
    }

    sealed class ThumbBar : IDisposable
    {
        public const int WM_COMMAND = 0x0111;
        public const int WM_SETTINGCHANGE = 0x001A;
        const int THBN_CLICKED = 0x1800;
        const uint THB_ICON = 0x2, THB_TOOLTIP = 0x4, THB_FLAGS = 0x8;
        const uint THBF_ENABLED = 0x0, THBF_DISABLED = 0x1;

        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern uint RegisterWindowMessage(string lpString);
        [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr hIcon);
        [DllImport("user32.dll")] static extern int GetSystemMetrics(int nIndex);

        static readonly uint CreatedMsg = RegisterWindowMessage("TaskbarButtonCreated");

        // ids dos botoes (1 a 7) e o nome que a pagina entende
        static readonly string[] Names = new string[] { null, "prev", "toggle", "next", "mic", "hear", "vdown", "vup" };

        public event Action<string> Clicked;                            // nome da acao ("prev", "toggle", ...)

        ITaskbarList3 list;
        IntPtr hwnd;
        bool added;                                                      // os 7 botoes ja foram criados nesta barra de tarefas
        bool dark = true;
        TbState state = new TbState();
        readonly Dictionary<string, IntPtr> icons = new Dictionary<string, IntPtr>();
        readonly bool testMode = Environment.GetEnvironmentVariable("LMMP_TEST") == "1";

        public int LastHr = int.MinValue;                                // resultado da ultima chamada ao Windows (0 = deu certo); para testes
        public int Updates;                                              // quantas vezes os botoes foram atualizados; para testes

        public bool Ready { get { return added; } }

        // devolve true quando a mensagem era dos botoes e ja foi tratada
        public bool HandleMessage(ref Message m)
        {
            if (m.Msg == CreatedMsg && CreatedMsg != 0) { Attach(m.HWnd); return false; }
            if (m.Msg == WM_COMMAND)
            {
                long w = m.WParam.ToInt64();
                if (((w >> 16) & 0xFFFF) == THBN_CLICKED)
                {
                    int id = (int)(w & 0xFFFF);
                    if (id >= 1 && id < Names.Length && Clicked != null) Clicked(Names[id]);
                    return true;
                }
            }
            if (m.Msg == WM_SETTINGCHANGE && m.LParam != IntPtr.Zero)    // trocou o tema claro/escuro do Windows: os icones mudam de cor
            {
                string what = null;
                try { what = Marshal.PtrToStringUni(m.LParam); } catch { }
                if (what == "ImmersiveColorSet" && added)
                {
                    bool d = IsDark();
                    if (d != dark) { dark = d; Apply(); }
                }
            }
            return false;
        }

        // a barra de tarefas criou o botao desta janela (e cria de novo se o Explorer reiniciar)
        void Attach(IntPtr h)
        {
            try
            {
                hwnd = h;
                dark = IsDark();
                list = (ITaskbarList3)new CTaskbarList();
                list.HrInit();
                added = false;
                Apply();
            }
            catch (Exception ex) { AppLog.Error(ex); list = null; }
        }

        public void SetState(TbState s)
        {
            if (s == null) return;
            if (s.ToString() == state.ToString()) return;
            state = s;
            Apply();
        }

        static bool IsDark()
        {
            try
            {
                using (RegistryKey k = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"))
                {
                    object v = k == null ? null : k.GetValue("SystemUsesLightTheme");
                    if (v is int) return (int)v == 0;
                }
            }
            catch { }
            return true;
        }

        void Apply()
        {
            if (list == null || hwnd == IntPtr.Zero) return;
            try
            {
                int size = Math.Max(16, GetSystemMetrics(49));          // SM_CXSMICON: 16 a 100% de escala, maior nas telas ampliadas
                ThumbButton[] b = BuildButtons(size);
                int hr = added ? list.ThumbBarUpdateButtons(hwnd, 7, b) : list.ThumbBarAddButtons(hwnd, 7, b);
                if (!added && hr == 0) added = true;
                LastHr = hr;
                Updates++;
                if (testMode) WriteTestLog(hr);
            }
            catch (Exception ex) { AppLog.Error(ex); }
        }

        ThumbButton Button(int id, string kind, Color color, string tip, bool enabled, int size)
        {
            ThumbButton t = new ThumbButton();
            t.dwMask = THB_ICON | THB_TOOLTIP | THB_FLAGS;
            t.iId = (uint)id;
            t.hIcon = Icon(kind, color, size);
            t.szTip = tip.Length > 259 ? tip.Substring(0, 259) : tip;
            t.dwFlags = enabled ? THBF_ENABLED : THBF_DISABLED;
            return t;
        }

        ThumbButton[] BuildButtons(int size)
        {
            Color white = dark ? Color.FromArgb(245, 245, 248) : Color.FromArgb(32, 32, 38);
            Color green = dark ? Color.FromArgb(94, 224, 160) : Color.FromArgb(14, 140, 88);
            Color red = dark ? Color.FromArgb(255, 106, 94) : Color.FromArgb(205, 40, 36);
            TbState s = state;
            bool has = s.P >= 0;
            ThumbButton[] b = new ThumbButton[7];
            b[0] = Button(1, "prev", white, "Anterior (volta ao começo ou ao vídeo de antes)", has, size);
            b[1] = Button(2, s.P == 1 ? "pause" : "play", white, s.P == 1 ? "Pausar" : "Reproduzir", has, size);
            b[2] = Button(3, "next", white, s.Nx == 1 ? "Próximo da fila" : "Próximo (não há mais vídeos na fila)", s.Nx == 1, size);

            string micTip = s.Mic < 0 ? "Microfone (entre numa sala para conversar por voz)" : s.Mic == 0 ? "Entrar na voz" : s.Mic == 1 ? "Silenciar o microfone" : "Ligar o microfone";
            b[3] = Button(4, s.Mic == 1 ? "mic" : "micoff", s.Mic == 1 ? green : (s.Mic == 2 ? red : white), micTip, s.Mic >= 0, size);

            string hearTip = s.Hear < 0 ? "Fone (entre na voz para ouvir a sala)" : s.Hear == 1 ? "Parar de ouvir as vozes da sala" : "Voltar a ouvir as vozes da sala";
            b[4] = Button(5, s.Hear == 0 ? "hpoff" : "hp", s.Hear == 1 ? green : (s.Hear == 0 ? red : white), hearTip, s.Hear >= 0, size);

            b[5] = Button(6, "volm", white, "Diminuir o volume do vídeo", has, size);
            b[6] = Button(7, "volp", white, "Aumentar o volume do vídeo", has, size);
            return b;
        }

        // ---------- icones (desenhados aqui mesmo, sem arquivos) ----------

        IntPtr Icon(string kind, Color c, int size)
        {
            string key = kind + "|" + c.ToArgb().ToString("x8", CultureInfo.InvariantCulture) + "|" + size;
            IntPtr h;
            if (icons.TryGetValue(key, out h)) return h;
            using (Bitmap bmp = Draw(kind, c, size))
            {
                h = bmp.GetHicon();
                if (testMode) DumpPng(bmp, kind, c, size);
            }
            icons[key] = h;
            return h;
        }

        static void FillRound(Graphics g, Brush br, float x, float y, float w, float h, float r)
        {
            using (GraphicsPath p = new GraphicsPath())
            {
                float d = Math.Min(Math.Min(r * 2f, w), h);
                p.AddArc(x, y, d, d, 180, 90);
                p.AddArc(x + w - d, y, d, d, 270, 90);
                p.AddArc(x + w - d, y + h - d, d, d, 0, 90);
                p.AddArc(x, y + h - d, d, d, 90, 90);
                p.CloseFigure();
                g.FillPath(br, p);
            }
        }

        static void Speaker(Graphics g, Brush br)
        {
            g.FillPolygon(br, new PointF[] { new PointF(2.5f, 9.5f), new PointF(6.5f, 9.5f), new PointF(11.5f, 5f), new PointF(11.5f, 19f), new PointF(6.5f, 14.5f), new PointF(2.5f, 14.5f) });
        }

        // risco diagonal "desligado": primeiro abre um vao transparente em volta, depois desenha o risco
        static void Slash(Graphics g, Pen pen)
        {
            using (Pen cut = new Pen(Color.Transparent, 3.6f))
            {
                cut.StartCap = LineCap.Round;
                cut.EndCap = LineCap.Round;
                CompositingMode old = g.CompositingMode;
                g.CompositingMode = CompositingMode.SourceCopy;
                g.DrawLine(cut, 4f, 3.5f, 20f, 20.5f);
                g.CompositingMode = old;
            }
            g.DrawLine(pen, 4f, 3.5f, 20f, 20.5f);
        }

        static Bitmap Draw(string kind, Color color, int size)
        {
            Bitmap bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.Clear(Color.Transparent);
                float k = size / 24f;
                g.ScaleTransform(k, k);                                  // o desenho abaixo e feito numa grade de 24 x 24
                using (SolidBrush br = new SolidBrush(color))
                using (Pen pen = new Pen(color, 2f))
                {
                    pen.StartCap = LineCap.Round;
                    pen.EndCap = LineCap.Round;
                    pen.LineJoin = LineJoin.Round;
                    switch (kind)
                    {
                        case "prev":
                            FillRound(g, br, 5f, 5f, 2.6f, 14f, 1f);
                            g.FillPolygon(br, new PointF[] { new PointF(19.5f, 5f), new PointF(8.8f, 12f), new PointF(19.5f, 19f) });
                            break;
                        case "next":
                            g.FillPolygon(br, new PointF[] { new PointF(4.5f, 5f), new PointF(15.2f, 12f), new PointF(4.5f, 19f) });
                            FillRound(g, br, 16.4f, 5f, 2.6f, 14f, 1f);
                            break;
                        case "play":
                            g.FillPolygon(br, new PointF[] { new PointF(7f, 4.2f), new PointF(20.5f, 12f), new PointF(7f, 19.8f) });
                            break;
                        case "pause":
                            FillRound(g, br, 5.6f, 4.5f, 4.6f, 15f, 1.2f);
                            FillRound(g, br, 13.8f, 4.5f, 4.6f, 15f, 1.2f);
                            break;
                        case "mic":
                        case "micoff":
                            FillRound(g, br, 9f, 2.5f, 6f, 11.5f, 3f);
                            g.DrawArc(pen, 5.5f, 6f, 13f, 12f, 0f, 180f);
                            g.DrawLine(pen, 12f, 18f, 12f, 21.5f);
                            g.DrawLine(pen, 8.5f, 21.5f, 15.5f, 21.5f);
                            if (kind == "micoff") Slash(g, pen);
                            break;
                        case "hp":
                        case "hpoff":
                            g.DrawArc(pen, 4.5f, 3.5f, 15f, 15f, 180f, 180f);
                            FillRound(g, br, 3f, 10.5f, 4.6f, 9.5f, 1.8f);
                            FillRound(g, br, 16.4f, 10.5f, 4.6f, 9.5f, 1.8f);
                            if (kind == "hpoff") Slash(g, pen);
                            break;
                        case "volm":
                            Speaker(g, br);
                            g.FillRectangle(br, 14f, 10.9f, 7.5f, 2.2f);
                            break;
                        case "volp":
                            Speaker(g, br);
                            g.FillRectangle(br, 14f, 10.9f, 7.5f, 2.2f);
                            g.FillRectangle(br, 16.65f, 8.2f, 2.2f, 7.6f);
                            break;
                    }
                }
            }
            return bmp;
        }

        // ---------- so para testes (LMMP_TEST=1): o que foi pedido ao Windows e como ficaram os icones ----------

        void WriteTestLog(int hr)
        {
            try
            {
                Directory.CreateDirectory(AppPaths.DataDir);
                File.WriteAllText(Path.Combine(AppPaths.DataDir, "tb.txt"),
                    "hr=" + hr + "\r\nupdates=" + Updates + "\r\nstate=" + state + "\r\ndark=" + dark + "\r\nadded=" + added + "\r\n");
            }
            catch { }
        }

        static void DumpPng(Bitmap bmp, string kind, Color c, int size)
        {
            try
            {
                string dir = Path.Combine(AppPaths.DataDir, "tb-icons");
                Directory.CreateDirectory(dir);
                bmp.Save(Path.Combine(dir, kind + "-" + c.ToArgb().ToString("x8", CultureInfo.InvariantCulture) + "-" + size + ".png"), ImageFormat.Png);
            }
            catch { }
        }

        public void Dispose()
        {
            foreach (IntPtr h in icons.Values) { try { DestroyIcon(h); } catch { } }
            icons.Clear();
            if (list != null)
            {
                try { Marshal.ReleaseComObject(list); } catch { }
                list = null;
            }
        }
    }
}
