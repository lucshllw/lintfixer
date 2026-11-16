using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

internal sealed class SplashForm : Form
{
    private readonly Timer animTimer;
    private int tick;

    public SplashForm()
    {
        Text = "LintFixer";
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(420, 220);
        BackColor = Color.FromArgb(9, 11, 14);
        DoubleBuffered = true;

        try
        {
            Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location);
        }
        catch { }

        animTimer = new Timer { Interval = 32 };
        animTimer.Tick += delegate
        {
            tick++;
            Invalidate();
        };
        animTimer.Start();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;

        using (var borderPen = new Pen(Color.FromArgb(30, 36, 45), 1))
        {
            g.DrawRectangle(borderPen, 0, 0, ClientSize.Width - 1, ClientSize.Height - 1);
        }

        // Animated Kat-Brackets B&W mark
        float ox = ClientSize.Width / 2f;
        float oy = 74f;
        float bracketShift = (float)Math.Sin(tick * 0.25) * 3f;
        using (var whiteBrush = new SolidBrush(Color.FromArgb(236, 239, 244)))
        using (var darkBrush = new SolidBrush(Color.FromArgb(9, 11, 14)))
        using (var whitePen = new Pen(Color.FromArgb(236, 239, 244), 3.2f) { StartCap = LineCap.Round, EndCap = LineCap.Round })
        {
            var head = new PointF[]
            {
                new PointF(ox - 24, oy - 24),
                new PointF(ox - 10, oy - 12),
                new PointF(ox + 10, oy - 12),
                new PointF(ox + 24, oy - 24),
                new PointF(ox + 27, oy + 2),
                new PointF(ox + 21, oy + 22),
                new PointF(ox - 21, oy + 22),
                new PointF(ox - 27, oy + 2),
            };
            g.FillPolygon(whiteBrush, head);

            // Terminal cursor eyes (blink periodically)
            float eyeH = (tick % 60 > 54) ? 1.2f : 4f;
            g.FillRectangle(darkBrush, ox - 14, oy + 1, 9, eyeH);
            g.FillRectangle(darkBrush, ox + 5, oy + 1, 9, eyeH);

            // Animated curly braces { }
            g.DrawArc(whitePen, ox - 38 - bracketShift, oy - 10, 10, 20, 90, 180);
            g.DrawArc(whitePen, ox + 28 + bracketShift, oy - 10, 10, 20, 270, 180);
        }

        using (var titleFont = new Font("Segoe UI", 14, FontStyle.Bold))
        using (var monoFont = new Font("Consolas", 9.5f))
        using (var boneBrush = new SolidBrush(Color.FromArgb(236, 239, 244)))
        using (var mutedBrush = new SolidBrush(Color.FromArgb(139, 149, 165)))
        using (var emeraldBrush = new SolidBrush(Color.FromArgb(34, 197, 139)))
        {
            var sf = new StringFormat { Alignment = StringAlignment.Center };
            g.DrawString("LintFixer · Rack Observatório", titleFont, boneBrush, ox, 122, sf);
            g.DrawString("Iniciando daemon loopback + Cofre AES-256-GCM/DPAPI...", monoFont, mutedBrush, ox, 152, sf);

            int barW = 280;
            int barX = (ClientSize.Width - barW) / 2;
            g.FillRectangle(new SolidBrush(Color.FromArgb(23, 28, 35)), barX, 184, barW, 6);
            int prog = Math.Min(barW, (tick * 9) % (barW + 40));
            g.FillRectangle(emeraldBrush, barX, 184, prog, 6);
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) animTimer.Dispose();
        base.Dispose(disposing);
    }
}

internal static class LauncherProgram
{
    [STAThread]
    private static int Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        string exeDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location) ?? Environment.CurrentDirectory;
        string entryScript = Path.Combine(exeDir, "bin", "lintfixer.mjs");
        if (!File.Exists(entryScript))
        {
            MessageBox.Show("Runtime LintFixer nao encontrado em: " + entryScript, "LintFixer", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        string nodeExe = FindNodeExecutable();
        if (nodeExe == null)
        {
            MessageBox.Show("Node.js (>= 22) necessario no PATH.", "LintFixer", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        var psi = new ProcessStartInfo
        {
            FileName = nodeExe,
            Arguments = "\"" + entryScript + "\" ui --no-anim " + string.Join(" ", args),
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
        };
        Process.Start(psi);

        using (var splash = new SplashForm())
        {
            var closeTimer = new Timer { Interval = 1350 };
            closeTimer.Tick += delegate
            {
                closeTimer.Stop();
                splash.Close();
            };
            closeTimer.Start();
            Application.Run(splash);
        }

        return 0;
    }

    private static string FindNodeExecutable()
    {
        string programFilesNode = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe");
        if (File.Exists(programFilesNode)) return programFilesNode;

        string pathEnv = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string dir in pathEnv.Split(Path.PathSeparator))
        {
            if (string.IsNullOrWhiteSpace(dir)) continue;
            try
            {
                string candidate = Path.Combine(dir.Trim(), "node.exe");
                if (File.Exists(candidate)) return candidate;
            }
            catch { }
        }
        return null;
    }
}
