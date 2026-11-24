namespace CSharpShooter.UpdateHandlers;

/// <summary>What CSharpShooter and its hook in a program debugged with Hot Reload say to each other (update-handlers.js has
/// the same words): the variable naming CSharpShooter's socket, which the hook connects to as the program starts, and says
/// the key it was given first; then a line from CSharpShooter for each type an update the debugger applied changed and one after it, and the hook's answer
/// once the handlers ran, a line of each handler's failure then the end.</summary>
internal static class Wire
{
    /// <summary>"port key": the loopback port CSharpShooter listens at for the hook, and the key that proves the hook its own.</summary>
    public const string SocketVariable = "CSHARPSHOOTER_UPDATE_HANDLERS";

    /// <summary>The runtime's startup hooks, this one among them.</summary>
    public const string StartupHooks = "DOTNET_STARTUP_HOOKS";

    /// <summary>CSharpShooter's line that ends an update's type lines: the debugger applied it.</summary>
    public const string Updated = "updated";

    /// <summary>A changed type's line, one before <see cref="Updated"/> for each: its module's identity and metadata token.</summary>
    public static string TypeLine(Guid module, int token) => $"type {module:D} {token:X8}";

    /// <summary>Reads a changed type's line.</summary>
    public static bool TryType(string line, out Guid module, out int token)
    {
        module = default;
        token = default;
        return line.Split(' ') is ["type", var id, var number]
            && Guid.TryParse(id, out module)
            && int.TryParse(number, System.Globalization.NumberStyles.HexNumber, System.Globalization.CultureInfo.InvariantCulture, out token);
    }

    /// <summary>How a line of the hook's answer begins that says a handler failed, its words after it.</summary>
    public const string Failed = "failed ";

    /// <summary>The hook's last line of an answer: the handlers ran.</summary>
    public const string Done = "done";

    /// <summary>The name of the hook's thread in the program, as its threads list it.</summary>
    public const string ThreadName = "CSharpShooter update handlers";
}
