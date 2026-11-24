using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CallHierarchy;
using Microsoft.CodeAnalysis.Extensions;
using Microsoft.CodeAnalysis.FindSymbols;
using Microsoft.CodeAnalysis.LanguageServer.Handler.CallHierarchy;
using Microsoft.CodeAnalysis.Shared.Extensions;

namespace Passenger.Roslyn.Extension;

/// <summary>textDocument/prepareCallHierarchy's item, made by the server's own parts in a document declaring the symbol (the
/// one asked about where it does), so a use of a member declared in another document has one, where the server's own
/// handler makes it only in the document asked about and answers none there; at a record's positional parameter, the
/// property it declares. Passenger's CallHierarchyRootHandler (0.4.1, #1916), answered as the LSP item's JSON, which
/// extension.js hands VS Code as the server's own answer; null where the server has no call hierarchy for the symbol
/// (a type, a local).</summary>
public sealed class PrepareCallHierarchy : IExtensionDocumentMessageHandler<Caret, JsonElement?>
{
    public async Task<JsonElement?> ExecuteAsync(Caret message, ExtensionMessageContext context, Document document, CancellationToken cancellationToken)
    {
        int position = await Changes.OffsetAsync(document, message.At, cancellationToken).ConfigureAwait(false);
        SemanticModel model = await document.GetRequiredSemanticModelAsync(cancellationToken).ConfigureAwait(false);
        if (await SymbolFinder.FindSymbolAtPositionAsync(model, position, document.Project.Solution.Services, includeType: true, cancellationToken).ConfigureAwait(false) is not { } found)
        {
            return null;
        }
        ISymbol symbol = PositionalPropertyAt(found, model.SyntaxTree, position) ?? found;
        if (await document.GetRequiredLanguageService<ICallHierarchyService>().CreateItemAsync(symbol, document.Project, cancellationToken).ConfigureAwait(false) is not { } described)
        {
            return null;
        }
        DocumentId? declaring = symbol.OriginalDefinition.DeclaringSyntaxReferences.Any(d => d.SyntaxTree == model.SyntaxTree) ? document.Id : null;
        return await CallHierarchyHelpers.CreateItemAsync(described, document.Project.Solution, declaring, cancellationToken).ConfigureAwait(false) is { } item
            ? JsonSerializer.SerializeToElement(item, Microsoft.CodeAnalysis.LanguageServer.ProtocolConversions.LspJsonSerializerOptions)
            : null;
    }

    /// <summary>The property a record's positional parameter declares, where a place is on the parameter's declaration;
    /// null for any other symbol or place, and for a parameter whose name a member the record declares itself takes.
    /// Passenger's SymbolNames.PositionalPropertyAt.</summary>
    private static IPropertySymbol? PositionalPropertyAt(ISymbol symbol, SyntaxTree tree, int position) =>
        symbol is IParameterSymbol { ContainingSymbol: IMethodSymbol { MethodKind: MethodKind.Constructor, ContainingType: { IsRecord: true } record } } parameter
        && parameter.Locations.FirstOrDefault(l => l.SourceTree == tree && l.SourceSpan.Start <= position && position <= l.SourceSpan.End) is { } declared
            ? record.GetMembers(parameter.Name).OfType<IPropertySymbol>().FirstOrDefault(p => p.Locations.Contains(declared))
            : null;
}
