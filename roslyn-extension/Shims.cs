using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

// What Passenger's refactoring handlers take from Passenger.Core and Passenger.Languages, which this extension does not
// carry: the few members they call, kept to the same names so the handlers' files stay Passenger's as they are.

namespace Passenger.Core
{
    internal static class Plural
    {
        /// <summary>Names said in words: "Api", "Api and Web", "Api, Web and Worker".</summary>
        public static string Listed(IReadOnlyList<string> names) =>
            names.Count <= 1 ? string.Concat(names) : $"{string.Join(", ", names.Take(names.Count - 1))} and {names[^1]}";
    }

    internal static class DeepText
    {
        // shortcut: Passenger's DeepText reads a long text on a thread with a stack sized for it; here on the caller's, as
        // these handlers did before. A parameter Change Signature writes is a line, not a file.
        public static T Read<T>(int characters, Func<T> read) => read();
    }
}

namespace Passenger.Languages.CSharp
{
    internal static class CodeBrackets
    {
        // shortcut: Passenger's CodeBrackets refuses (null) a text nested too deeply for the parser's stack; here it is parsed as
        // given, as this extension's handlers did before. A parameter typed into Change Signature is never that deep.
        public static ExpressionSyntax? Expression(string text) => SyntaxFactory.ParseExpression(text);

        public static TypeSyntax? TypeName(string text) => SyntaxFactory.ParseTypeName(text);
    }
}
