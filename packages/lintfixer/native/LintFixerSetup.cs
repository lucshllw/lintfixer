using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Threading.Tasks;
using System.Windows.Forms;

internal sealed class SetupForm : Form
{
    private readonly Timer animTimer;
    private readonly Button installBtn;
    private readonly Button launchBtn;
    private int tick;
    private int progressPct;
    private string statusLine = "Pronto para instalar o LintFixer em AppData\\Local\\LintFixer";
    private bool installed;
    private readonly bool autoRun;

    public SetupForm(bool autoRun)
    {
        this.autoRun = autoRun;
        Text = "LintFixer Setup — Instalador Kat-Brackets";
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(560, 360);
        BackColor = Color.FromArgb(9, 11, 14);
        ForeColor = Color.FromArgb(236, 239, 244);
        DoubleBuffered = true;

        try
        {
            Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location);
        }
        catch { }

        installBtn = new Button
        {
            Text = "INSTALAR & INICIAR",
            FlatStyle = FlatStyle.Flat,
            BackColor = Color.FromArgb(30, 201, 143),
            ForeColor = Color.FromArgb(7, 20, 14),
            Font = new Font("Consolas", 10, FontStyle.Bold),
            Size = new Size(195, 38),
            Location = new Point(341, 298),
        };
        installBtn.FlatAppearance.BorderSize = 0;
        installBtn.Click += async delegate { await RunInstallAsync(); };

        launchBtn = new Button
        {
            Text = "ABRIR LINTFIXER",
            Visible = false,
            FlatStyle = FlatStyle.Flat,
            BackColor = Color.FromArgb(236, 239, 244),
            ForeColor = Color.FromArgb(9, 11, 14),
            Font = new Font("Consolas", 10, FontStyle.Bold),
            Size = new Size(195, 38),
            Location = new Point(341, 298),
        };
        launchBtn.FlatAppearance.BorderSize = 0;
        launchBtn.Click += delegate { LaunchInstalledApp(); Close(); };

        Controls.Add(installBtn);
        Controls.Add(launchBtn);

        animTimer = new Timer { Interval = 32 };
        animTimer.Tick += delegate
        {
            tick++;
            Invalidate();
        };
        animTimer.Start();

        Shown += async delegate
        {
            if (this.autoRun)
            {
                await RunInstallAsync();
                Close();
            }
        };
    }

    private async Task RunInstallAsync()
    {
        if (installed) return;
        installBtn.Enabled = false;
        string appRoot = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "LintFixer",
            "app"
        );
        string binDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "LintFixer",
            "bin"
        );

        await Task.Run(() =>
        {
            UpdateProgress(15, "Verificando runtime e preparando pasta isolada...");
            Directory.CreateDirectory(appRoot);
            Directory.CreateDirectory(binDir);

            UpdateProgress(40, "Extraindo LintFixer UI + Core + DPAPI Helper...");
            using (Stream resStream = Assembly.GetExecutingAssembly().GetManifestResourceStream("runtime-payload.zip"))
            {
                if (resStream == null)
                {
                    throw new InvalidOperationException("Payload interno nao encontrado.");
                }
                string tmpZip = Path.Combine(Path.GetTempPath(), "lintfixer-payload-" + Process.GetCurrentProcess().Id + ".zip");
                using (var fs = File.Create(tmpZip))
                {
                    resStream.CopyTo(fs);
                }
                try
                {
                    if (Directory.Exists(appRoot))
                    {
                        Directory.Delete(appRoot, true);
                    }
                    ZipFile.ExtractToDirectory(tmpZip, appRoot);
                }
                finally
                {
                    if (File.Exists(tmpZip)) File.Delete(tmpZip);
                }
            }

            UpdateProgress(72, "Registrando comando CLI `lintfixer` e atalho Desktop...");
            string cmdPath = Path.Combine(binDir, "lintfixer.cmd");
            File.WriteAllText(cmdPath, "@echo off\r\nnode \"" + Path.Combine(appRoot, "bin", "lintfixer.mjs") + "\" %*\r\n");

            string userPath = Environment.GetEnvironmentVariable("PATH", EnvironmentVariableTarget.User) ?? "";
            if (userPath.IndexOf(binDir, StringComparison.OrdinalIgnoreCase) < 0)
            {
                string nextPath = string.IsNullOrWhiteSpace(userPath) ? binDir : userPath.TrimEnd(';') + ";" + binDir;
                Environment.SetEnvironmentVariable("PATH", nextPath, EnvironmentVariableTarget.User);
            }

            CreateShortcut(appRoot);
            UpdateProgress(100, "Instalacao concluida! Cofre AES-256-GCM + DPAPI pronto.");
        });

        installed = true;
        installBtn.Visible = false;
        launchBtn.Visible = true;
        if (!autoRun)
        {
            LaunchInstalledApp();
        }
    }

    private void UpdateProgress(int pct, string text)
    {
        if (InvokeRequired)
        {
            Invoke((Action)(() => { progressPct = pct; statusLine = text; Invalidate(); }));
            return;
        }
        progressPct = pct;
        statusLine = text;
        Invalidate();
    }

    private static void LaunchInstalledApp()
    {
        string appRoot = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "LintFixer",
            "app"
        );
        string exe = Path.Combine(appRoot, "LintFixer.exe");
        if (File.Exists(exe))
        {
            Process.Start(new ProcessStartInfo(exe, "--setup") { UseShellExecute = true });
        }
    }

    private static void CreateShortcut(string appRoot)
    {
        try
        {
            string exe = Path.Combine(appRoot, "LintFixer.exe");
            string ico = Path.Combine(appRoot, "assets", "kat-brackets.ico");
            string desktopLnk = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "LintFixer.lnk");
            string startDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs");
            string startLnk = Path.Combine(startDir, "LintFixer.lnk");

            string psScript =
                "$ws = New-Object -ComObject WScript.Shell; " +
                "$s1 = $ws.CreateShortcut('" + desktopLnk.Replace("'", "''") + "'); $s1.TargetPath='" + exe.Replace("'", "''") + "'; $s1.IconLocation='" + ico.Replace("'", "''") + "'; $s1.Save(); " +
                "$s2 = $ws.CreateShortcut('" + startLnk.Replace("'", "''") + "'); $s2.TargetPath='" + exe.Replace("'", "''") + "'; $s2.IconLocation='" + ico.Replace("'", "''") + "'; $s2.Save();";

            var psi = new ProcessStartInfo
            {
                FileName = "powershell.exe",
                Arguments = "-NoProfile -NonInteractive -Command \"" + psScript.Replace("\"", "\\\"") + "\"",
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
            };
            var proc = Process.Start(psi);
            if (proc != null) proc.WaitForExit(6000);
        }
        catch { }
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;

        using (var border = new Pen(Color.FromArgb(30, 36, 45), 1))
        {
            g.DrawRectangle(border, 12, 12, ClientSize.Width - 25, ClientSize.Height - 25);
        }

        // Animated Kat-Brackets Logo
        float ox = 86f;
        float oy = 102f;
        float shift = (float)Math.Sin(tick * 0.18) * 3.5f;
        using (var white = new SolidBrush(Color.FromArgb(236, 239, 244)))
        using (var dark = new SolidBrush(Color.FromArgb(9, 11, 14)))
        using (var pen = new Pen(Color.FromArgb(236, 239, 244), 3.6f) { StartCap = LineCap.Round, EndCap = LineCap.Round })
        {
            g.FillPolygon(white, new[]
            {
                new PointF(ox - 28, oy - 28),
                new PointF(ox - 11, oy - 14),
                new PointF(ox + 11, oy - 14),
                new PointF(ox + 28, oy - 28),
                new PointF(ox + 32, oy + 4),
                new PointF(ox + 25, oy + 26),
                new PointF(ox - 25, oy + 26),
                new PointF(ox - 32, oy + 4),
            });
            float eyeH = (tick % 70 > 63) ? 1.5f : 5f;
            g.FillRectangle(dark, ox - 16, oy + 2, 11, eyeH);
            g.FillRectangle(dark, ox + 5, oy + 2, 11, eyeH);
            g.DrawArc(pen, ox - 45 - shift, oy - 12, 12, 24, 90, 180);
            g.DrawArc(pen, ox + 33 + shift, oy - 12, 12, 24, 270, 180);
        }

        using (var titleFont = new Font("Segoe UI", 18, FontStyle.Bold))
        using (var subFont = new Font("Segoe UI", 10))
        using (var monoFont = new Font("Consolas", 9.5f))
        using (var bone = new SolidBrush(Color.FromArgb(236, 239, 244)))
        using (var muted = new SolidBrush(Color.FromArgb(152, 162, 179)))
        using (var emerald = new SolidBrush(Color.FromArgb(34, 197, 139)))
        {
            g.DrawString("LintFixer v0.2.0", titleFont, bone, 154, 58);
            g.DrawString("Linter Semântico · Git Score · Busca GitHub · Cofre DPAPI", subFont, muted, 156, 94);
            g.DrawString("Interface Rack Observatório + Mascote Kat-Brackets", subFont, muted, 156, 118);

            g.DrawString(statusLine, monoFont, bone, 28, 206);

            // 14-segment progress bar matching Proposta C UI
            int segs = 14;
            int barX = 28;
            int barY = 236;
            int gap = 5;
            int totalW = ClientSize.Width - 56;
            int segW = (totalW - gap * (segs - 1)) / segs;
            int filled = (int)Math.Round((progressPct / 100.0) * segs);
            for (int i = 0; i < segs; i++)
            {
                var brush = i < filled ? emerald : new SolidBrush(Color.FromArgb(35, 42, 52));
                g.FillRectangle(brush, barX + i * (segW + gap), barY, segW, 12);
            }

            g.DrawString("INSTALAÇÃO LOCAL: %LOCALAPPDATA%\\LintFixer (SEM CHAVES EM REPO)", monoFont, muted, 28, 308);
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) animTimer.Dispose();
        base.Dispose(disposing);
    }
}

internal static class SetupProgram
{
    [STAThread]
    private static int Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        bool autoRun = Array.Exists(args, a => a == "--auto" || a == "--silent");
        Application.Run(new SetupForm(autoRun));
        return 0;
    }
}
