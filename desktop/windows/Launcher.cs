using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class Launcher {
    [STAThread]
    private static void Main() {
        try {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            var start = new ProcessStartInfo(Path.Combine(root, "node.exe")) {
                Arguments = "\"" + Path.Combine(root, "resources", "power", "desktop", "launch.mjs") + "\"",
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            start.EnvironmentVariables["POWER_ELECTRON"] = Path.Combine(root, "runtime", "electron.exe");
            using (var process = Process.Start(start)) {
                process.WaitForExit();
                if (process.ExitCode != 0) MessageBox.Show("Power could not start. Please restart Power or reinstall the app. Your data is kept in your user profile's .power folder.", "Power", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        } catch (Exception e) {
            MessageBox.Show(e.Message, "Power startup error", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
