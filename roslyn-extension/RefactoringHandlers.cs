using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Extensions;

namespace Passenger.Roslyn.Extension;

// Each reads the solution the server has open, with the open files as the editor has them, and answers with what it
// would change; the server names each by its type's full name. Passenger.Roslyn.Extension's Handlers.cs (7358d41)
// without DocumentTexts.

public sealed class DescribeSignature : IExtensionDocumentMessageHandler<Caret, Signature>
{
    public Task<Signature> ExecuteAsync(Caret message, ExtensionMessageContext context, Document document, CancellationToken cancellationToken) =>
        Signatures.DescribeAsync(document, message.At, cancellationToken);
}

public sealed class ChangeSignature : IExtensionDocumentMessageHandler<SignatureChange, Refactored>
{
    public Task<Refactored> ExecuteAsync(SignatureChange message, ExtensionMessageContext context, Document document, CancellationToken cancellationToken) =>
        Signatures.ChangeAsync(document, message, cancellationToken);
}

public sealed class DescribeInterface : IExtensionDocumentMessageHandler<Caret, InterfaceSource>
{
    public Task<InterfaceSource> ExecuteAsync(Caret message, ExtensionMessageContext context, Document document, CancellationToken cancellationToken) =>
        Interfaces.DescribeAsync(document, message.At, cancellationToken);
}

public sealed class ExtractInterface : IExtensionDocumentMessageHandler<InterfaceExtraction, Refactored>
{
    public Task<Refactored> ExecuteAsync(InterfaceExtraction message, ExtensionMessageContext context, Document document, CancellationToken cancellationToken) =>
        Interfaces.ExtractAsync(document, message, cancellationToken);
}

public sealed class DescribeType : IExtensionDocumentMessageHandler<Caret, TypeSource>
{
    public Task<TypeSource> ExecuteAsync(Caret message, ExtensionMessageContext context, Document document, CancellationToken cancellationToken) =>
        TypeMoves.DescribeAsync(document, message.At, cancellationToken);
}

public sealed class MoveTypeToFile : IExtensionDocumentMessageHandler<TypeToFile, Refactored>
{
    public Task<Refactored> ExecuteAsync(TypeToFile message, ExtensionMessageContext context, Document document, CancellationToken cancellationToken) =>
        TypeMoves.ToFileAsync(document, message, cancellationToken);
}

public sealed class MoveTypeToNamespace : IExtensionDocumentMessageHandler<TypeToNamespace, Refactored>
{
    public Task<Refactored> ExecuteAsync(TypeToNamespace message, ExtensionMessageContext context, Document document, CancellationToken cancellationToken) =>
        TypeMoves.ToNamespaceAsync(document, message, cancellationToken);
}

public sealed class DescribeHierarchy : IExtensionDocumentMessageHandler<Caret, Hierarchy>
{
    public Task<Hierarchy> ExecuteAsync(Caret message, ExtensionMessageContext context, Document document, CancellationToken cancellationToken) =>
        MemberMoves.DescribeAsync(document, message.At, cancellationToken);
}

public sealed class PullMembersUp : IExtensionDocumentMessageHandler<MembersMove, Refactored>
{
    public Task<Refactored> ExecuteAsync(MembersMove message, ExtensionMessageContext context, Document document, CancellationToken cancellationToken) =>
        MemberMoves.PullUpAsync(document, message, cancellationToken);
}

public sealed class PushMembersDown : IExtensionDocumentMessageHandler<MembersMove, Refactored>
{
    public Task<Refactored> ExecuteAsync(MembersMove message, ExtensionMessageContext context, Document document, CancellationToken cancellationToken) =>
        MemberMoves.PushDownAsync(document, message, cancellationToken);
}
