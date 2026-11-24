using System.Net;
using System.Net.Sockets;
using System.Text;
using CSharpShooter.UpdateHandlers;

/// <summary>Run before the program's Main, as DOTNET_STARTUP_HOOKS names this assembly, only in a program CSharpShooter
/// debugs with Hot Reload: it takes itself and its variable out of what the program's children inherit, connects to
/// CSharpShooter's socket and says its key, starts a thread of its own to read it and answer, and returns once that thread
/// has made every call of its own and is about to wait in its first read (Passenger 0.3.4's hook, #1495). A stop between
/// updates then finds the thread in the system's receive, partway through nothing an evaluation there could need; the
/// program's handlers still run for the first time at the first update. It never waits on CSharpShooter: the connection
/// is to a loopback port already listening, the thread waits only to start, and a socket that cannot be reached leaves
/// the program as it would run without the hook.</summary>
internal static class StartupHook
{
    /// <summary>The longest Main waits for the thread to reach its first read, in milliseconds of the clock, the time a
    /// debugger holds the program counted too: past it the program goes on, the thread reaching its read on its own.</summary>
    private const long StartLimitMilliseconds = 2000;

    /// <summary>The longest line read: each of CSharpShooter's names a type or ends an update, and a longer one is passed over.</summary>
    private const int LongestLine = 256;

    /// <summary>Whether the thread has come to its first read, written by it with nothing of .NET's left to run before it.</summary>
    private static bool reading;

    public static void Initialize()
    {
        string? variable = Environment.GetEnvironmentVariable(Wire.SocketVariable);
        Environment.SetEnvironmentVariable(Wire.SocketVariable, null);
        TakeOut(typeof(StartupHook).Assembly.Location);
        if (variable?.Split(' ') is not [{ } port, { Length: > 0 } key] || !int.TryParse(port, out int number) || Open(number, key) is not { } socket)
        {
            return;
        }
        Thread listening = new(() => Serve(socket)) { IsBackground = true, Name = Wire.ThreadName };
        listening.UnsafeStart();
        long until = Environment.TickCount64 + StartLimitMilliseconds;
        SpinWait waiting = default;
        while (!Volatile.Read(ref reading) && Environment.TickCount64 < until)
        {
            // Never Sleep(1), whose least on Windows is the clock's tick: the thread is a moment from its read.
            waiting.SpinOnce(sleep1Threshold: -1);
        }
    }

    /// <summary>Connected to CSharpShooter's loopback port with the key said; null where it cannot be.</summary>
    private static Socket? Open(int port, string key)
    {
        Socket socket = new(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
        try
        {
            socket.Connect(new IPEndPoint(IPAddress.Loopback, port));
            if (!Send(socket, Line(key)))
            {
                socket.Dispose();
                return null;
            }
            return socket;
        }
        catch (Exception error) when (error is SocketException or ObjectDisposedException)
        {
            socket.Dispose();
            return null;
        }
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
    /// socket closes; says it is <see cref="reading"/> once <see cref="Ready"/> has made every call it makes but those of
    /// the program's handlers, its next step its first read.</summary>
    private static void Serve(Socket socket)
    {
        using Socket open = socket;
        byte[] updated = Encoding.ASCII.GetBytes(Wire.Updated);
        byte[] buffer = new byte[LongestLine];
        ChangedTypes changes = new();
        Ready(open, buffer, updated);
        Volatile.Write(ref reading, true);
        int kept = 0;
        // Set while a line longer than the buffer is passed over, up to its end.
        bool passing = false;
        while (Receive(open, buffer, kept) is > 0 and int read)
        {
            int length = kept + read;
            int start = 0;
            for (int end = kept; end < length; end++)
            {
                if (buffer[end] != '\n')
                {
                    continue;
                }
                if (!passing)
                {
                    if (Says(buffer, start, end - start, updated))
                    {
                        if (!Answer(open, Handlers.Run(changes.Take(AppDomain.CurrentDomain.GetAssemblies()))))
                        {
                            return;
                        }
                    }
                    else
                    {
                        changes.Add(Encoding.ASCII.GetString(buffer, start, end - start));
                    }
                }
                passing = false;
                start = end + 1;
            }
            passing |= length - start == buffer.Length;
            kept = passing ? 0 : length - start;
            Array.Copy(buffer, start, buffer, 0, kept);
        }
    }

    /// <summary>Makes once each of the hook's own calls of reading CSharpShooter's lines and answering them: a receive that
    /// waits for nothing and takes nothing (a peek of a socket made not to block, its error code returned, not thrown), a
    /// line matched, a failure's words encoded, a send of no bytes, an answer of nothing, and the handlers looked for in
    /// this assembly alone, which declares none. Finding, reading and calling the program's own handlers is first done at
    /// the first update.</summary>
    private static void Ready(Socket open, byte[] buffer, byte[] updated)
    {
        open.Blocking = false;
        open.Receive(buffer, 0, buffer.Length, SocketFlags.Peek, out SocketError _);
        open.Blocking = true;
        Receive(open, buffer, buffer.Length);
        Says(updated, 0, updated.Length, updated);
        Line(Wire.Failed + "a\nb");
        Send(open, []);
        ChangedTypes changes = new();
        changes.Add(Wire.TypeLine(typeof(StartupHook).Module.ModuleVersionId, typeof(StartupHook).MetadataToken));
        Handlers.Run([typeof(StartupHook).Assembly], changes.Take([typeof(StartupHook).Assembly]));
        Answer(open, [], done: false);
        Array.Copy(buffer, 0, buffer, 0, 0);
    }

    /// <summary>What a receive into <paramref name="buffer"/> after its first <paramref name="kept"/> bytes took: 0 once the
    /// socket closed or failed, and nothing asked of a full buffer.</summary>
    private static int Receive(Socket socket, byte[] buffer, int kept)
    {
        if (kept >= buffer.Length)
        {
            return 0;
        }
        int read = socket.Receive(buffer, kept, buffer.Length - kept, SocketFlags.None, out SocketError error);
        return error == SocketError.Success ? read : 0;
    }

    /// <summary>Whether the whole line went; false once CSharpShooter has gone.</summary>
    private static bool Send(Socket socket, byte[] line)
    {
        int sent = 0;
        while (sent < line.Length)
        {
            int now = socket.Send(line, sent, line.Length - sent, SocketFlags.None, out SocketError error);
            if (error != SocketError.Success || now <= 0)
            {
                return false;
            }
            sent += now;
        }
        return true;
    }

    /// <summary>Whether the bytes of <paramref name="buffer"/> from <paramref name="start"/> are those of <paramref name="line"/>.</summary>
    private static bool Says(byte[] buffer, int start, int length, byte[] line) =>
        length == line.Length && buffer.AsSpan(start, length).SequenceEqual(line);

    /// <summary>Says each of the handlers' failures, then that they ran unless <paramref name="done"/> is false; false once
    /// CSharpShooter has gone.</summary>
    private static bool Answer(Socket socket, IReadOnlyList<string> failures, bool done = true)
    {
        foreach (string failure in failures)
        {
            if (!Send(socket, Line(Wire.Failed + failure)))
            {
                return false;
            }
        }
        return !done || Send(socket, Line(Wire.Done));
    }

    /// <summary>A line of the wire: its words on one line, in UTF-8.</summary>
    private static byte[] Line(string words) => Encoding.UTF8.GetBytes(words.ReplaceLineEndings(" ") + "\n");
}
