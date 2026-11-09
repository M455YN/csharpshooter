// One JSON line in, one out: {"id":1,"text":"select ..."} -> {"id":1,"errors":[{line,character,endLine,endCharacter,message}]},
// 0-based, the errors SQL Tools Service would underline (its ParseOptions and its CreateMarkerFromError's positions).
// The first argument is the UI language ("pl"), for the parser's own translated messages.
using System.Globalization;
using System.Text.Json;
using Microsoft.SqlServer.Management.SqlParser.Common;
using Microsoft.SqlServer.Management.SqlParser.Parser;

if (args.Length > 0) CultureInfo.DefaultThreadCurrentUICulture = CultureInfo.CurrentUICulture = new CultureInfo(args[0]);
var options = new ParseOptions(batchSeparator: "GO", isQuotedIdentifierSet: true,
    compatibilityLevel: DatabaseCompatibilityLevel.Current, transactSqlVersion: TransactSqlVersion.Current);
// T-SQL's reserved keywords and the clause words a line starts with.
var Keywords = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
{
    "add", "all", "alter", "and", "any", "apply", "as", "asc", "begin", "between", "break", "by", "case", "catch", "close",
    "commit", "continue", "create", "cross", "cursor", "deallocate", "declare", "default", "delete", "desc", "distinct",
    "drop", "else", "end", "except", "exec", "execute", "exists", "fetch", "for", "from", "full", "go", "goto", "group",
    "having", "if", "in", "inner", "insert", "intersect", "into", "is", "join", "left", "like", "merge", "not", "null",
    "offset", "on", "open", "option", "or", "order", "outer", "over", "partition", "pivot", "print", "raiserror", "return",
    "right", "rollback", "rows", "select", "set", "then", "throw", "top", "tran", "transaction", "truncate", "try", "union",
    "unpivot", "update", "use", "using", "values", "when", "where", "while", "with", "output", "matched", "target", "source",
};
var output = Console.OpenStandardOutput();
string? line;
while ((line = Console.ReadLine()) != null)
{
    if (line.Length == 0) continue;
    using var request = JsonDocument.Parse(line);
    var id = request.RootElement.GetProperty("id").GetInt64();
    var text = request.RootElement.GetProperty("text").GetString() ?? "";
    JsonSerializer.Serialize(output, new { id, errors = Check(text) });
    output.WriteByte((byte)'\n');
    output.Flush();
}

// The parser stops reporting within a statement after its first error ("wherse ... ordser by" says only wherse), as
// SSMS 22 does too (RadLangSvc reads one ParseResult's Errors): the rest of each erroring line is blanked (spaces, so
// positions stay) and the text parsed again. An error found so is kept only where it looks like a mistyped clause word
// starting its line (ordser, frm); anything else (a number, a bracket, a real keyword, the end) is the blanking's own
// echo, and the search stops there.
List<object> Check(string text)
{
    var found = new List<object>();
    var chars = text.ToCharArray();
    var lastLine = -1;
    for (var round = 0; round < 5; round++)
    {
        var errors = Parser.Parse(new string(chars), options).Errors
            .Where(e => e.Start.LineNumber - 1 > lastLine).ToList();
        if (round > 0) errors = errors.Take(1).Where(e => MistypedWord(text, e.Start.LineNumber - 1, e.Start.ColumnNumber - 1)).ToList();
        if (errors.Count == 0) break;
        foreach (var e in errors)
        {
            found.Add(new
            {
                line = e.Start.LineNumber - 1,
                character = e.Start.ColumnNumber - 1,
                endLine = e.End.LineNumber - 1,
                endCharacter = e.End.ColumnNumber - 1,
                message = e.Message,
            });
        }
        var last = errors[^1];
        lastLine = last.Start.LineNumber - 1;
        // Location.Offset is not an index into the text: the error's index from its line and column
        var at = 0;
        for (var l = 0; l < lastLine && at >= 0; l++) at = Array.IndexOf(chars, '\n', at) is var n and >= 0 ? n + 1 : -1;
        if (at < 0) break;
        at += last.Start.ColumnNumber - 1;
        if (at >= chars.Length) break; // at the end of the text: nothing after it
        for (var i = at; i < chars.Length && chars[i] != '\n'; i++) if (chars[i] != '\r') chars[i] = ' ';
    }
    return found;
}

// A word of letters first on its line that T-SQL does not know as a keyword: a clause word mistyped.
bool MistypedWord(string text, int line, int column)
{
    var lines = text.Split('\n');
    if (line >= lines.Length) return false;
    var row = lines[line].TrimEnd('\r');
    if (column >= row.Length || row[..column].Trim().Length > 0) return false;
    var end = column;
    while (end < row.Length && char.IsLetter(row[end])) end++;
    if (end == column || (end < row.Length && (char.IsLetterOrDigit(row[end]) || row[end] == '_' || row[end] == '.'))) return false;
    return !Keywords.Contains(row[column..end]);
}

