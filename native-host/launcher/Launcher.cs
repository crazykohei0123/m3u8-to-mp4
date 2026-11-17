// m3u8host.exe - Chrome Native Messaging launcher
// Chrome cannot execute a .js/.bat host directly on Windows, so this tiny
// launcher starts "node host.js" and passes Chrome's stdio pipes through.
// Build:  C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /target:exe /out:m3u8host.exe Launcher.cs
// (C# 5 compatible: no string interpolation / expression-bodied members)

using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

internal static class Launcher
{
    private static string BaseDir
    {
        get
        {
            try
            {
                return Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
            }
            catch (Exception)
            {
                return Directory.GetCurrentDirectory();
            }
        }
    }

    private static int Main()
    {
        string dir = BaseDir;
        string hostJs = Path.Combine(dir, "host.js");
        string logPath = Path.Combine(dir, "launcher.log");

        try
        {
            if (!File.Exists(hostJs))
            {
                Log(logPath, "host.js not found: " + hostJs);
                return 3;
            }

            string node = ResolveNode(dir, logPath);
            if (node == null)
            {
                Log(logPath, "node.exe not found. Re-run install.ps1 (it writes node-path.txt).");
                return 2;
            }

            // .NET は子プロセスの stdin に UTF-8 BOM を書くことがあるため、
            // BOM なしのエンコーディングを指定しておく（host.js 側でも除去する）
            try { Console.InputEncoding = new UTF8Encoding(false); } catch (Exception) { }

            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = node;
            psi.Arguments = "\"" + hostJs + "\"";
            psi.WorkingDirectory = dir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            // Chrome から見える stdio はパイプ。子プロセスへ単純継承させると
            // ハンドルが無効になる環境があるため、明示的に中継する。
            psi.RedirectStandardInput = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;

            Process p = Process.Start(psi);
            if (p == null)
            {
                Log(logPath, "failed to start node: " + node);
                return 4;
            }

            Thread tin = new Thread(delegate() { Pump("stdin", Console.OpenStandardInput(), p.StandardInput.BaseStream, logPath); });
            tin.IsBackground = true;
            tin.Start();

            Thread tout = new Thread(delegate() { Pump("stdout", p.StandardOutput.BaseStream, Console.OpenStandardOutput(), logPath); });
            tout.IsBackground = true;
            tout.Start();

            Thread terr = new Thread(delegate() { Pump("stderr", p.StandardError.BaseStream, Console.OpenStandardError(), logPath); });
            terr.IsBackground = true;
            terr.Start();

            p.WaitForExit();
            tout.Join(3000);
            return p.ExitCode;
        }
        catch (Exception ex)
        {
            Log(logPath, ex.ToString());
            return 1;
        }
    }

    /* 双方向にバイト列をそのまま流す（フレーミングには一切触らない） */
    private static void Pump(string tag, Stream src, Stream dst, string logPath)
    {
        byte[] buf = new byte[8192];
        long total = 0;
        string error = null;
        try
        {
            int n;
            while ((n = src.Read(buf, 0, buf.Length)) > 0)
            {
                dst.Write(buf, 0, n);
                dst.Flush();
                total += n;
            }
        }
        catch (Exception ex) { error = ex.GetType().Name + ": " + ex.Message; }
        try { dst.Flush(); } catch (Exception) { }
        try { dst.Close(); } catch (Exception) { }
        if (error != null)
        {
            Log(logPath, "pump[" + tag + "] stopped after " + total + " bytes: " + error);
        }
    }

    private static string ResolveNode(string dir, string logPath)
    {
        // 1) install.ps1 が書き出した node-path.txt
        string cfg = Path.Combine(dir, "node-path.txt");
        if (File.Exists(cfg))
        {
            string first = null;
            foreach (string line in File.ReadAllLines(cfg))
            {
                if (line != null && line.Trim().Length > 0) { first = line.Trim(); break; }
            }
            if (first != null && File.Exists(first)) return first;
            if (first != null) Log(logPath, "node-path.txt points to a missing file: " + first);
        }

        // 2) PATH
        string pathEnv = Environment.GetEnvironmentVariable("PATH");
        if (!string.IsNullOrEmpty(pathEnv))
        {
            string[] parts = pathEnv.Split(';');
            for (int i = 0; i < parts.Length; i++)
            {
                string d = parts[i].Trim().Trim('"');
                if (d.Length == 0) continue;
                try
                {
                    string cand = Path.Combine(d, "node.exe");
                    if (File.Exists(cand)) return cand;
                }
                catch (Exception) { }
            }
        }

        // 3) よくある場所
        string[] guesses = new string[]
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "nodejs", "node.exe")
        };
        for (int i = 0; i < guesses.Length; i++)
        {
            if (File.Exists(guesses[i])) return guesses[i];
        }
        return null;
    }

    private static void Log(string logPath, string message)
    {
        try
        {
            File.AppendAllText(logPath,
                DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + message + Environment.NewLine,
                Encoding.UTF8);
        }
        catch (Exception) { }
    }
}
