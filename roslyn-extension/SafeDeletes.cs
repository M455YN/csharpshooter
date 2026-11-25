using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.FindSymbols;
using Microsoft.CodeAnalysis.Text;

namespace Passenger.Roslyn.Extension;

/// <summary>Safe Delete: the declaration of the symbol at the caret (or of the one a use there names) and what deleting it
/// takes out of its file, with its doc comment and the lines it has to itself, and the uses of it the solution has
/// elsewhere, which deleting it would leave broken. Passenger 0.4.5's SafeDeletion (Passenger.Languages), on the
/// server's syntax, and its app's search for the uses, on the server's own.</summary>
internal static class SafeDeletes
{
    private sealed record Removal(TextSpan Span, string Name, string Kind, string? WhyNot = null);

    private static SafeDeletion Refused(string problem) => new(problem, string.Empty, string.Empty, string.Empty, null, []);

    public static async Task<SafeDeletion> DescribeAsync(Document document, Place at, CancellationToken cancel)
    {
        int offset = await Changes.OffsetAsync(document, at, cancel).ConfigureAwait(false);
        SyntaxNode root = (await document.GetSyntaxRootAsync(cancel).ConfigureAwait(false))!;
        SourceText text = await document.GetTextAsync(cancel).ConfigureAwait(false);
        Document declaring = document;
        Removal? removal = At(root, text, offset);
        if (removal is null)
        {
            // a use: its symbol's one declaration in this solution's code
            ISymbol? used = await SymbolFinder.FindSymbolAtPositionAsync(document, offset, cancel).ConfigureAwait(false);
            if (used is null)
            {
                return Refused("Nothing to delete here: put the caret on a name");
            }
            Location[] declared = [.. used.Locations.Where(l => l.IsInSource)];
            if (declared.Length != 1)
            {
                return Refused(declared.Length == 0 ? $"Safe Delete deletes only what this solution's own code declares, not '{used.Name}'"
                    : $"Safe Delete cannot delete '{used.Name}', declared in {declared.Length} places");
            }
            if (document.Project.Solution.GetDocument(declared[0].SourceTree) is not { } other)
            {
                return Refused($"Safe Delete cannot read the file '{used.Name}' is declared in");
            }
            declaring = other;
            offset = declared[0].SourceSpan.Start;
            root = (await declaring.GetSyntaxRootAsync(cancel).ConfigureAwait(false))!;
            text = await declaring.GetTextAsync(cancel).ConfigureAwait(false);
            removal = At(root, text, offset);
        }
        if (removal is null)
        {
            return Refused("Safe Delete removes a type, a member or a local, and none is declared here");
        }
        if (removal.WhyNot is { } why)
        {
            return Refused(why);
        }
        SemanticModel model = (await declaring.GetSemanticModelAsync(cancel).ConfigureAwait(false))!;
        if (model.GetDeclaredSymbol(root.FindToken(offset).Parent!, cancel) is not { } symbol)
        {
            return Refused($"Safe Delete cannot tell what '{removal.Name}' is");
        }
        if (symbol.Locations.Count(l => l.IsInSource) > 1)
        {
            return Refused($"Safe Delete cannot delete '{removal.Name}', declared in several places (a partial type)");
        }
        List<UseLeft> uses = [];
        HashSet<(string, int)> seen = [];
        foreach (ReferencedSymbol referenced in await SymbolFinder.FindReferencesAsync(symbol, declaring.Project.Solution, cancel).ConfigureAwait(false))
        {
            foreach (ReferenceLocation use in referenced.Locations)
            {
                if (use.IsImplicit || !use.Location.IsInSource || use.Document.FilePath is not { } path)
                {
                    continue;
                }
                TextSpan span = use.Location.SourceSpan;
                // its own uses go with it (a recursive call, a type's own constructor)
                bool inside = path == declaring.FilePath && removal.Span.Contains(span);
                if (inside || !seen.Add((path, span.Start)))
                {
                    continue;
                }
                SourceText usedIn = await use.Document.GetTextAsync(cancel).ConfigureAwait(false);
                LinePosition place = usedIn.Lines.GetLinePosition(span.Start);
                uses.Add(new UseLeft(path, new Place(place.Line, place.Character), usedIn.Lines[place.Line].ToString().Trim()));
            }
        }
        LinePosition start = text.Lines.GetLinePosition(removal.Span.Start);
        LinePosition end = text.Lines.GetLinePosition(removal.Span.End);
        Edit edit = new(new Place(start.Line, start.Character), new Place(end.Line, end.Character), string.Empty);
        return new SafeDeletion(null, removal.Name, removal.Kind, declaring.FilePath ?? string.Empty, edit,
            [.. uses.OrderBy(u => u.Path, StringComparer.OrdinalIgnoreCase).ThenBy(u => u.At.Line)]);
    }

    /// <summary>What deleting the declaration whose name is at an offset takes out of its file, or null when no name of a
    /// declaration is there.</summary>
    private static Removal? At(SyntaxNode root, SourceText text, int offset)
    {
        SyntaxToken name = root.FindToken(offset);
        if (!name.IsKind(SyntaxKind.IdentifierToken) || name.Parent is not { } declared)
        {
            return null;
        }
        string id = name.ValueText;
        return declared switch
        {
            VariableDeclaratorSyntax { Parent: VariableDeclarationSyntax { Parent: FieldDeclarationSyntax field } list } v
                => Declarator(text, v, list, field, field.Modifiers.Any(m => m.IsKind(SyntaxKind.ConstKeyword)) ? "constant" : "field"),
            VariableDeclaratorSyntax { Parent: VariableDeclarationSyntax { Parent: EventFieldDeclarationSyntax field } list } v => Declarator(text, v, list, field, "event"),
            VariableDeclaratorSyntax { Parent: VariableDeclarationSyntax { Parent: LocalDeclarationStatementSyntax local } list } v
                => Declarator(text, v, list, local, "local variable"),
            MethodDeclarationSyntax m when m.Identifier == name => Whole(text, m, id, "method"),
            PropertyDeclarationSyntax p when p.Identifier == name => Whole(text, p, id, "property"),
            EventDeclarationSyntax e when e.Identifier == name => Whole(text, e, id, "event"),
            ConstructorDeclarationSyntax c when c.Identifier == name => Whole(text, c, id, "constructor"),
            EnumMemberDeclarationSyntax e => EnumMember(text, e, id),
            DelegateDeclarationSyntax d when d.Identifier == name => Whole(text, d, id, "delegate"),
            BaseTypeDeclarationSyntax t when t.Identifier == name => Whole(text, t, id, t switch
            {
                InterfaceDeclarationSyntax => "interface",
                StructDeclarationSyntax => "struct",
                RecordDeclarationSyntax => "record",
                EnumDeclarationSyntax => "enum",
                _ => "class",
            }),
            LocalFunctionStatementSyntax f when f.Identifier == name => Whole(text, f, id, "local function"),
            ParameterSyntax => new Removal(default, id, "parameter", "Safe Delete removes a type, a member or a local; a parameter is left to Change Signature"),
            _ => null,
        };
    }

    /// <summary>One of a declaration's names: the whole declaration when it is the only one, else the name and the comma
    /// that parts it from the next (or the one before, for the last).</summary>
    private static Removal Declarator(SourceText text, VariableDeclaratorSyntax variable, VariableDeclarationSyntax list, SyntaxNode declaration, string kind)
    {
        string name = variable.Identifier.ValueText;
        SeparatedSyntaxList<VariableDeclaratorSyntax> variables = list.Variables;
        if (variables.Count == 1)
        {
            return Whole(text, declaration, name, kind);
        }
        int index = variables.IndexOf(variable);
        TextSpan span = index < variables.Count - 1
            ? TextSpan.FromBounds(variable.SpanStart, variables[index + 1].SpanStart)
            : TextSpan.FromBounds(variables.GetSeparator(index - 1).SpanStart, variable.Span.End);
        return new Removal(span, name, kind);
    }

    /// <summary>An enum member with the comma that parts it from the next, as a whole declaration; the last, with none
    /// after it, from the comma before it, unless a comment follows that comma or a directive or text it leaves out lies
    /// before the member, when that comma stays as the enum's last.</summary>
    private static Removal EnumMember(SourceText text, EnumMemberDeclarationSyntax member, string name)
    {
        const string Kind = "enum member";
        SeparatedSyntaxList<EnumMemberDeclarationSyntax> members = ((EnumDeclarationSyntax)member.Parent!).Members;
        int index = members.IndexOf(member);
        if (index < members.SeparatorCount)
        {
            return Whole(text, member, members.GetSeparator(index), name, Kind);
        }
        if (index == 0
            || members.GetSeparator(index - 1).TrailingTrivia.Any(t => !t.IsKind(SyntaxKind.EndOfLineTrivia) && !t.IsKind(SyntaxKind.WhitespaceTrivia))
            || member.GetLeadingTrivia().Any(t => t.IsDirective || t.IsKind(SyntaxKind.DisabledTextTrivia)))
        {
            return Whole(text, member, member.GetLastToken(), name, Kind);
        }
        return new Removal(TextSpan.FromBounds(members.GetSeparator(index - 1).SpanStart, End(member.GetLastToken())), name, Kind);
    }

    private static Removal Whole(SourceText text, SyntaxNode node, string name, string kind) => Whole(text, node, node.GetLastToken(), name, kind);

    /// <summary>A whole declaration, from its doc comment to its last token (or the comma after it) and a comment after
    /// that on its line: its lines when it has them to itself, then a blank line it would leave beside another or against
    /// a brace; else its text and the spaces after it.</summary>
    private static Removal Whole(SourceText text, SyntaxNode node, SyntaxToken through, string name, string kind)
    {
        int start = node.GetLeadingTrivia().FirstOrDefault(t => t.IsKind(SyntaxKind.SingleLineDocumentationCommentTrivia)
            || t.IsKind(SyntaxKind.MultiLineDocumentationCommentTrivia)) is { RawKind: not 0 } doc ? doc.FullSpan.Start : node.SpanStart;
        int end = End(through);
        int firstLine = text.Lines.IndexOf(start);
        int lastLine = text.Lines.IndexOf(end);
        TextLine first = text.Lines[firstLine];
        TextLine last = text.Lines[lastLine];
        if (!Blank(text, first.Start, start) || !Blank(text, end, last.End))
        {
            int after = end;
            while (after < last.End && text[after] is ' ' or '\t')
            {
                after++;
            }
            return new Removal(TextSpan.FromBounds(start, after), name, kind);
        }
        int from = first.Start;
        int to = last.EndIncludingLineBreak;
        TextLine? before = firstLine > 0 ? text.Lines[firstLine - 1] : null;
        TextLine? next = lastLine + 1 < text.Lines.Count ? text.Lines[lastLine + 1] : null;
        bool beforeBlank = before is { } b && Blank(text, b.Start, b.End);
        bool nextBlank = next is { } n && n.EndIncludingLineBreak > n.Start && Blank(text, n.Start, n.End);
        bool opens = before is not { } o || o.ToString().TrimEnd().EndsWith('{');
        bool closes = next is not { } c || c.ToString().TrimStart().StartsWith('}');
        if (beforeBlank && (nextBlank || closes))
        {
            from = before!.Value.Start;
        }
        else if (nextBlank && opens)
        {
            to = next!.Value.EndIncludingLineBreak;
        }
        return new Removal(TextSpan.FromBounds(from, to), name, kind);
    }

    /// <summary>Where a token ends with a comment after it on its line.</summary>
    private static int End(SyntaxToken token)
    {
        int end = token.Span.End;
        foreach (SyntaxTrivia trailing in token.TrailingTrivia)
        {
            if (!trailing.IsKind(SyntaxKind.EndOfLineTrivia) && !trailing.IsKind(SyntaxKind.WhitespaceTrivia))
            {
                end = trailing.Span.End;
            }
        }
        return end;
    }

    private static bool Blank(SourceText text, int start, int end)
    {
        for (int i = start; i < end; i++)
        {
            if (!char.IsWhiteSpace(text[i]))
            {
                return false;
            }
        }
        return true;
    }
}
