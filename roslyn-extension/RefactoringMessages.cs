using System.Text.Json.Serialization;

namespace Passenger.Roslyn.Extension;

// The refactorings' messages, Passenger.Roslyn.Extension's Messages.cs (7358d41) cut to them; names given for
// System.Text.Json's defaults.

/// <summary>A place in a document as the server counts it: a line and a UTF-16 column, from zero.</summary>
public sealed record Place([property: JsonPropertyName("line")] int Line, [property: JsonPropertyName("character")] int Character);

/// <summary>Where the caret is: what a describing message asks about.</summary>
public sealed record Caret([property: JsonPropertyName("at")] Place At);

/// <summary>One edit to a file's text, between two places of it as it was.</summary>
public sealed record Edit(
    [property: JsonPropertyName("start")] Place Start,
    [property: JsonPropertyName("end")] Place End,
    [property: JsonPropertyName("text")] string Text);

/// <summary>What a refactoring does to one file: its edits, or, for a file it makes, its whole text as the one edit.</summary>
public sealed record FileChange(
    [property: JsonPropertyName("path")] string Path,
    [property: JsonPropertyName("created")] bool Created,
    [property: JsonPropertyName("edits")] IReadOnlyList<Edit> Edits);

/// <summary>A refactoring's answer: the files it changes, or why it changes none; and the uses it leaves as they were,
/// which the change leaves wrong.</summary>
public sealed record Refactored(
    [property: JsonPropertyName("problem")] string? Problem,
    [property: JsonPropertyName("changes")] IReadOnlyList<FileChange> Changes,
    [property: JsonPropertyName("left")] IReadOnlyList<UseLeft>? Left = null);

/// <summary>A use a refactoring could not change: its file, its place in the file as it was, and why, as words that
/// name it ("Circle.Make as a Func&lt;double, Circle&gt;, which the new signature no longer fits").</summary>
public sealed record UseLeft(
    [property: JsonPropertyName("path")] string Path,
    [property: JsonPropertyName("at")] Place At,
    [property: JsonPropertyName("why")] string Why);

/// <summary>A parameter as a signature has it: its modifier (ref, out, in, params, this, or none), type, name and the
/// default value its declaration gives (none when empty).</summary>
public sealed record Parameter(
    [property: JsonPropertyName("modifier")] string Modifier,
    [property: JsonPropertyName("type")] string Type,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("defaultValue")] string DefaultValue);

/// <summary>The method or constructor at the caret, for Change Signature: what it is ("method", "constructor"),
/// its type's name, its modifiers ("public static"), its name, its return type (empty for a constructor), its parameters,
/// and whether it extends a type, whose first parameter stays first. A problem instead when there is none to change.</summary>
public sealed record Signature(
    [property: JsonPropertyName("problem")] string? Problem,
    [property: JsonPropertyName("kind")] string Kind,
    [property: JsonPropertyName("container")] string Container,
    [property: JsonPropertyName("modifiers")] string Modifiers,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("returnType")] string ReturnType,
    [property: JsonPropertyName("parameters")] IReadOnlyList<Parameter> Parameters,
    [property: JsonPropertyName("isExtension")] bool IsExtension);

/// <summary>A parameter of the signature asked for: the one it was (its place in the old signature), or -1 for a new one
/// with the value every call passes for it.</summary>
public sealed record ParameterChange(
    [property: JsonPropertyName("from")] int From,
    [property: JsonPropertyName("modifier")] string Modifier,
    [property: JsonPropertyName("type")] string Type,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("defaultValue")] string DefaultValue,
    [property: JsonPropertyName("callValue")] string CallValue);

/// <summary>Change Signature's request: the method at the caret given this name, return type and parameters.</summary>
public sealed record SignatureChange(
    [property: JsonPropertyName("at")] Place At,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("returnType")] string ReturnType,
    [property: JsonPropertyName("parameters")] IReadOnlyList<ParameterChange> Parameters);

/// <summary>A member a type could give an interface or a base type: its id (its documentation comment id), how it reads
/// ("Add(int, int): int"), and what it is (method, property, indexer, event, field).</summary>
public sealed record Member(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("text")] string Text,
    [property: JsonPropertyName("kind")] string Kind);

/// <summary>The type at the caret, for Extract Interface: its name, the interface's suggested name and file, its
/// namespace, and the members it could give the interface. A problem instead when there is none.</summary>
public sealed record InterfaceSource(
    [property: JsonPropertyName("problem")] string? Problem,
    [property: JsonPropertyName("type")] string Type,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("fileName")] string FileName,
    [property: JsonPropertyName("namespace")] string Namespace,
    [property: JsonPropertyName("members")] IReadOnlyList<Member> Members);

/// <summary>Extract Interface's request: an interface of this name in a new file of this name beside the type's, holding
/// the members chosen, which the type then implements.</summary>
public sealed record InterfaceExtraction(
    [property: JsonPropertyName("at")] Place At,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("fileName")] string FileName,
    [property: JsonPropertyName("members")] IReadOnlyList<string> Members);

/// <summary>The type at the caret, for Move: its name and kind, its namespace (empty for the global one), the
/// file it is in, the file it would move to, and how many types that file declares. A problem instead when there is none.</summary>
public sealed record TypeSource(
    [property: JsonPropertyName("problem")] string? Problem,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("kind")] string Kind,
    [property: JsonPropertyName("namespace")] string Namespace,
    [property: JsonPropertyName("fileName")] string FileName,
    [property: JsonPropertyName("targetFileName")] string TargetFileName,
    [property: JsonPropertyName("typesInFile")] int TypesInFile);

/// <summary>Move to Another File's request: the type at the caret into a new file of this name beside its own.</summary>
public sealed record TypeToFile(
    [property: JsonPropertyName("at")] Place At,
    [property: JsonPropertyName("fileName")] string FileName);

/// <summary>Move to Namespace's request: the type at the caret into this namespace, its users following.</summary>
public sealed record TypeToNamespace(
    [property: JsonPropertyName("at")] Place At,
    [property: JsonPropertyName("namespace")] string Namespace);

/// <summary>A type's place in its hierarchy, for Pull Members Up and Push Members Down: its name, its members that
/// could move, the base types in the solution they could go up to, and its derived types they could go down to.</summary>
public sealed record Hierarchy(
    [property: JsonPropertyName("problem")] string? Problem,
    [property: JsonPropertyName("type")] string Type,
    [property: JsonPropertyName("members")] IReadOnlyList<Member> Members,
    [property: JsonPropertyName("bases")] IReadOnlyList<Member> Bases,
    [property: JsonPropertyName("derived")] IReadOnlyList<Member> Derived);

/// <summary>Pull Members Up's or Push Members Down's request: these members of the class at the caret moved into the base
/// type named by its id (up), or into each derived class whose id is a line of the target (down); those listed as abstract
/// made abstract where they stay.</summary>
public sealed record MembersMove(
    [property: JsonPropertyName("at")] Place At,
    [property: JsonPropertyName("target")] string Target,
    [property: JsonPropertyName("members")] IReadOnlyList<string> Members,
    [property: JsonPropertyName("abstract")] IReadOnlyList<string> Abstract);
