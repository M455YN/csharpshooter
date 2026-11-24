using System.Reflection;

namespace CSharpShooter.UpdateHandlers;

/// <summary>One update's changed types, as CSharpShooter names them (their module's identity and metadata token), resolved
/// inside the program once its metadata has changed (Passenger's ChangedTypes, #1534).</summary>
internal sealed class ChangedTypes
{
    private readonly HashSet<(Guid Module, int Token)> pending = [];

    public void Add(string line)
    {
        if (Wire.TryType(line, out Guid module, out int token))
        {
            pending.Add((module, token));
        }
    }

    /// <summary>Each type in every loaded copy of its module; null (every type may have changed, as before) where one can't
    /// be resolved or none was named, rather than a handler given an incomplete list. The batch is taken either way.</summary>
    public Type[]? Take(IEnumerable<Assembly> assemblies)
    {
        try
        {
            if (pending.Count == 0)
            {
                return null;
            }
            ILookup<Guid, Module> modules = assemblies.Where(a => !a.IsDynamic).SelectMany(a => a.GetModules()).ToLookup(m => m.ModuleVersionId);
            HashSet<Type> types = [];
            foreach ((Guid module, int token) in pending)
            {
                if (!modules.Contains(module))
                {
                    return null;
                }
                foreach (Module loaded in modules[module])
                {
                    types.Add(loaded.ResolveType(token));
                }
            }
            return [.. types];
        }
        catch (Exception error) when (error is ArgumentException or TypeLoadException or FileNotFoundException or BadImageFormatException or NotSupportedException)
        {
            return null;
        }
        finally
        {
            pending.Clear();
        }
    }
}
