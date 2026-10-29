namespace Passenger.Core;

/// <summary>Paths compared as Passenger.Core's PathNames compares them (Interfaces.cs asks it), without the rest of it.</summary>
internal static class PathNames
{
    private static readonly StringComparison Comparison =
        OperatingSystem.IsWindows() || OperatingSystem.IsMacOS() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;

    public static bool Same(string path, string other) => string.Equals(path, other, Comparison);
}
