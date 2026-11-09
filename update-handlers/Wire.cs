namespace CSharpShooter.UpdateHandlers;

/// <summary>What CSharpShooter and its hook in a program debugged with Hot Reload say to each other (update-handlers.js has
/// the same words): the variable naming CSharpShooter's socket, which the hook connects to as the program starts, and says
/// the key it was given first; then a line from CSharpShooter after each update the debugger applied, and the hook's answer
/// once the handlers ran, a line of each handler's failure then the end.</summary>
internal static class Wire
{
    /// <summary>"port key": the loopback port CSharpShooter listens at for the hook, and the key that proves the hook its own.</summary>
    public const string SocketVariable = "CSHARPSHOOTER_UPDATE_HANDLERS";

    /// <summary>The runtime's startup hooks, this one among them.</summary>
    public const string StartupHooks = "DOTNET_STARTUP_HOOKS";

    /// <summary>CSharpShooter's line: the debugger applied an update, every type of which may have changed.</summary>
    public const string Updated = "updated";

    /// <summary>How a line of the hook's answer begins that says a handler failed, its words after it.</summary>
    public const string Failed = "failed ";

    /// <summary>The hook's last line of an answer: the handlers ran.</summary>
    public const string Done = "done";
}
