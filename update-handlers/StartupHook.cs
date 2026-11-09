using System.Net;
using System.Net.Sockets;
using System.Text;
using CSharpShooter.UpdateHandlers;

/// <summary>Run before the program's Main, as DOTNET_STARTUP_HOOKS names this assembly, only in a program CSharpShooter
/// debugs with Hot Reload: it takes itself and its variable out of what the program's children inherit, and connects to
/// CSharpShooter's socket on a thread of its own. It never waits on CSharpShooter in the program's way: the thread is a
/// background one, and a socket that cannot be reached leaves the program as it would run without the hook.</summary>
internal static class StartupHook
{
    public static void Initialize()
    {
        string? socket = Environment.GetEnvironmentVariable(Wire.SocketVariable);
        Environment.SetEnvironmentVariable(Wire.SocketVariable, null);
        TakeOut(typeof(StartupHook).Assembly.Location);
        if (socket?.Split(' ') is not [{ } port, { Length: > 0 } key] || !int.TryParse(port, out int number))
        {
            return;
        }
        Thread listening = new(() => Serve(number, key)) { IsBackground = true, Name = "CSharpShooter update handlers" };
        listening.Start();
    }

    /// <summary>This hook out of the process's startup hooks, so the programs it starts do not load it; the others stay.</summary>
    private static void TakeOut(string hook)
    {
        if (Environment.GetEnvironmentVariable(Wire.StartupHooks) is { Length: > 0 } hooks)
        {
            string[] others = [.. hooks.Split(Path.PathSeparator).Where(h => h.Length > 0 && !string.Equals(Path.GetFullPath(h), hook, StringComparison.OrdinalIgnoreCase))];
            Environment.SetEnvironmentVariable(Wire.StartupHooks, others.Length == 0 ? null : string.Join(Path.PathSeparator, others));
        }
    }

    /// <summary>Calls the handlers after each update CSharpShooter says was applied, answering what they came to, until the
    /// socket closes.</summary>
    private static void Serve(int port, string key)
    {
        try
        {
            using Socket socket = new(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
            socket.Connect(new IPEndPoint(IPAddress.Loopback, port));
            using NetworkStream stream = new(socket, ownsSocket: false);
            using StreamReader reader = new(stream, new UTF8Encoding(false));
            using StreamWriter writer = new(stream, new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" };
            writer.WriteLine(key);
            while (reader.ReadLine() is { } line)
            {
                if (line != Wire.Updated)
                {
                    continue;
                }
                foreach (string failure in Handlers.Run())
                {
                    writer.WriteLine(Wire.Failed + failure.ReplaceLineEndings(" "));
                }
                writer.WriteLine(Wire.Done);
            }
        }
        catch (Exception error) when (error is SocketException or IOException or ObjectDisposedException)
        {
            // CSharpShooter gone or never reached: the program runs on as it would without the hook.
        }
    }
}
