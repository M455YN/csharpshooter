// The Test Explorer's bridge to VSTest, as Visual Studio's Test Explorer reaches it: vstest.console of the folder's .NET SDK,
// driven through VSTest's translation layer (VsTestConsoleWrapper). test-engine.js talks to it over stdin and stdout, one
// JSON message a line:
//   requests   { "id": 1, "method": "discover" | "run" | "cancel" | "exit", "params": { ... } }  -> { "id": 1, "result": ... }
//   from here  { "method": "found" | "results" | "running" | "log", "params": { ... } }          (notifications)
//              { "id": "b1", "method": "attach" | "launch", "params": { ... } } -> { "id": "b1", "result": ... }
// A debugged run is VSTest's custom test host: vstest.console starts the test host and asks the IDE to attach to it
// (ITestHostLauncher3.AttachDebuggerToProcess), and runs nothing in it until the IDE says the debugger has it.
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.TestPlatform.VsTestConsole.TranslationLayer;
using Microsoft.VisualStudio.TestPlatform.ObjectModel;
using Microsoft.VisualStudio.TestPlatform.ObjectModel.Client;
using Microsoft.VisualStudio.TestPlatform.ObjectModel.Client.Interfaces;
using Microsoft.VisualStudio.TestPlatform.ObjectModel.Logging;

namespace CSharpShooter.TestBridge;

public static class Program
{
    private const string RunSettings = "<RunSettings><RunConfiguration><DesignMode>true</DesignMode><CollectSourceInformation>true</CollectSourceInformation></RunConfiguration></RunSettings>";

    private static readonly object Writing = new();
    private static readonly ConcurrentDictionary<string, TaskCompletionSource<JsonNode?>> Asked = new();
    private static readonly ConcurrentDictionary<Guid, TestCase> Cases = new();
    private static int asking;
    private static VsTestConsoleWrapper? console;

    public static int Main(string[] args)
    {
        Console.InputEncoding = System.Text.Encoding.UTF8;
        Console.OutputEncoding = System.Text.Encoding.UTF8;
        string? line;
        while ((line = Console.In.ReadLine()) is not null)
        {
            JsonObject message;
            try
            {
                message = JsonNode.Parse(line)!.AsObject();
            }
            catch (JsonException)
            {
                continue;
            }
            string? method = (string?)message["method"];
            JsonNode? id = message["id"]?.DeepClone();
            if (method is null)
            {
                // An answer to what this asked (attach, launch).
                if (id is not null && Asked.TryRemove(id.ToString(), out var waiting))
                {
                    if (message["error"] is { } error)
                    {
                        waiting.TrySetException(new InvalidOperationException(error.ToString()));
                    }
                    else
                    {
                        waiting.TrySetResult(message["result"]?.DeepClone());
                    }
                }
                continue;
            }
            if (method == "exit")
            {
                break;
            }
            JsonObject parameters = message["params"] as JsonObject ?? [];
            // Each request on its own thread: a run blocks until it ends, and cancel must get through meanwhile.
            _ = Task.Run(() =>
            {
                try
                {
                    JsonNode? result = method switch
                    {
                        "discover" => Discover(parameters),
                        "run" => Run(parameters),
                        "cancel" => Cancel(),
                        _ => throw new InvalidOperationException($"Unknown method {method}"),
                    };
                    Send(new JsonObject { ["id"] = id, ["result"] = result });
                }
                catch (Exception failed)
                {
                    Send(new JsonObject { ["id"] = id, ["error"] = new JsonObject { ["message"] = failed.Message } });
                }
            });
        }
        try
        {
            console?.EndSession();
        }
        catch (Exception)
        {
            // vstest.console already gone
        }
        return 0;
    }

    private static void Send(JsonObject message)
    {
        string text = message.ToJsonString();
        lock (Writing)
        {
            Console.Out.Write(text);
            Console.Out.Write('\n');
            Console.Out.Flush();
        }
    }

    private static void Notify(string method, JsonObject parameters) => Send(new JsonObject { ["method"] = method, ["params"] = parameters });

    /// <summary>Asks test-engine.js something and waits for its answer (VSTest waits on this thread for it).</summary>
    private static JsonNode? Ask(string method, JsonObject parameters)
    {
        string id = $"b{Interlocked.Increment(ref asking)}";
        var answer = new TaskCompletionSource<JsonNode?>(TaskCreationOptions.RunContinuationsAsynchronously);
        Asked[id] = answer;
        Send(new JsonObject { ["id"] = id, ["method"] = method, ["params"] = parameters });
        return answer.Task.GetAwaiter().GetResult();
    }

    /// <summary>vstest.console of the .NET SDK the folder builds with (its global.json's), started once.</summary>
    private static VsTestConsoleWrapper Console_(string folder)
    {
        if (console is not null)
        {
            return console;
        }
        string dotnet = Environment.ProcessPath ?? "dotnet";
        var version = new ProcessStartInfo(dotnet, "--version") { WorkingDirectory = folder, RedirectStandardOutput = true, UseShellExecute = false, CreateNoWindow = true };
        using var process = Process.Start(version)!;
        string sdk = process.StandardOutput.ReadToEnd().Trim();
        process.WaitForExit();
        string path = Path.Combine(Path.GetDirectoryName(dotnet)!, "sdk", sdk, "vstest.console.dll");
        if (!File.Exists(path))
        {
            throw new InvalidOperationException($"vstest.console.dll not found for the .NET SDK {sdk} ({path})");
        }
        var parameters = new ConsoleParameters();
        if (Environment.GetEnvironmentVariable("CSHARPSHOOTER_VSTEST_LOG") is { Length: > 0 } log)
        {
            parameters.LogFilePath = log;
            parameters.TraceLevel = TraceLevel.Verbose;
        }
        var wrapper = new VsTestConsoleWrapper(path, parameters);
        wrapper.StartSession();
        console = wrapper;
        return wrapper;
    }

    private static string SettingsOf(JsonObject parameters) => (string?)parameters["settings"] is { Length: > 0 } settings ? settings : RunSettings;

    private static JsonNode? Discover(JsonObject parameters)
    {
        string[] sources = parameters["sources"]!.AsArray().Select(s => (string)s!).ToArray();
        var wrapper = Console_((string?)parameters["folder"] ?? Path.GetDirectoryName(sources[0])!);
        var handler = new DiscoveryHandler();
        wrapper.DiscoverTests(sources, SettingsOf(parameters), new TestPlatformOptions(), handler);
        handler.Done.Wait();
        return new JsonObject { ["count"] = handler.Count, ["aborted"] = handler.Aborted };
    }

    private static JsonNode? Run(JsonObject parameters)
    {
        bool debug = (bool?)parameters["debug"] ?? false;
        string settings = SettingsOf(parameters);
        var handler = new RunHandler();
        var options = new TestPlatformOptions();
        if (parameters["ids"] is JsonArray ids)
        {
            List<TestCase> chosen = [];
            foreach (var id in ids)
            {
                if (Guid.TryParse((string?)id, out Guid key) && Cases.TryGetValue(key, out var found))
                {
                    chosen.Add(found);
                }
            }
            if (chosen.Count == 0)
            {
                throw new InvalidOperationException("None of the tests asked for was discovered");
            }
            var wrapper = Console_(Path.GetDirectoryName(chosen[0].Source)!);
            if (debug)
            {
                wrapper.RunTestsWithCustomTestHost(chosen, settings, options, handler, new DebugLauncher());
            }
            else
            {
                wrapper.RunTests(chosen, settings, options, handler);
            }
        }
        else
        {
            string[] sources = parameters["sources"]!.AsArray().Select(s => (string)s!).ToArray();
            var wrapper = Console_(Path.GetDirectoryName(sources[0])!);
            if (debug)
            {
                wrapper.RunTestsWithCustomTestHost(sources, settings, options, handler, new DebugLauncher());
            }
            else
            {
                wrapper.RunTests(sources, settings, options, handler);
            }
        }
        handler.Done.Wait();
        return new JsonObject { ["aborted"] = handler.Aborted, ["canceled"] = handler.Canceled, ["error"] = handler.Error, ["elapsed"] = handler.Elapsed };
    }

    private static JsonNode? Cancel()
    {
        console?.CancelTestRun();
        console?.CancelDiscovery();
        return true;
    }

    private static void Log(TestMessageLevel level, string? message)
    {
        if (!string.IsNullOrWhiteSpace(message))
        {
            Notify("log", new JsonObject { ["level"] = level.ToString().ToLowerInvariant(), ["message"] = message });
        }
    }

    private static object? Property(TestObject test, string id)
    {
        foreach (TestProperty property in test.Properties)
        {
            if (property.Id == id)
            {
                return test.GetPropertyValue(property);
            }
        }
        return null;
    }

    private static JsonObject Describe(TestCase test) => new()
    {
        ["id"] = test.Id.ToString(),
        ["fqn"] = test.FullyQualifiedName,
        ["name"] = test.DisplayName,
        ["source"] = test.Source,
        ["file"] = test.CodeFilePath,
        ["line"] = test.LineNumber,
        ["type"] = Property(test, "TestCase.ManagedType") as string,
        ["method"] = Property(test, "TestCase.ManagedMethod") as string,
        ["traits"] = new JsonArray(test.Traits.Select(t => (JsonNode)new JsonObject { ["name"] = t.Name, ["value"] = t.Value }).ToArray()),
    };

    private static JsonObject Describe(TestResult result)
    {
        string Messages(string category) => string.Join("", result.Messages.Where(m => m.Category == category).Select(m => m.Text));
        string outcome = result.Outcome switch
        {
            TestOutcome.Passed => "passed",
            TestOutcome.Failed => "failed",
            _ => "skipped",
        };
        JsonObject described = Describe(result.TestCase);
        described["outcome"] = outcome;
        described["duration"] = result.Duration.TotalMilliseconds;
        described["message"] = result.ErrorMessage ?? (result.Outcome == TestOutcome.Skipped ? Messages(TestResultMessage.AdditionalInfoCategory) : null);
        described["stack"] = result.ErrorStackTrace;
        described["stdout"] = Messages(TestResultMessage.StandardOutCategory);
        described["stderr"] = Messages(TestResultMessage.StandardErrorCategory);
        described["resultName"] = result.DisplayName;
        return described;
    }

    private sealed class DiscoveryHandler : ITestDiscoveryEventsHandler2
    {
        public ManualResetEventSlim Done { get; } = new();
        public int Count;
        public bool Aborted;

        private void Found(IEnumerable<TestCase>? tests)
        {
            if (tests is null)
            {
                return;
            }
            JsonArray list = [];
            foreach (TestCase test in tests)
            {
                Cases[test.Id] = test;
                list.Add(Describe(test));
                Count++;
            }
            if (list.Count > 0)
            {
                Notify("found", new JsonObject { ["tests"] = list });
            }
        }

        public void HandleDiscoveredTests(IEnumerable<TestCase>? discoveredTestCases) => Found(discoveredTestCases);

        public void HandleDiscoveryComplete(DiscoveryCompleteEventArgs discoveryCompleteEventArgs, IEnumerable<TestCase>? lastChunk)
        {
            Found(lastChunk);
            Aborted = discoveryCompleteEventArgs.IsAborted;
            Done.Set();
        }

        public void HandleLogMessage(TestMessageLevel level, string? message) => Log(level, message);

        public void HandleRawMessage(string rawMessage)
        {
        }
    }

    private sealed class RunHandler : ITestRunEventsHandler
    {
        public ManualResetEventSlim Done { get; } = new();
        public bool Aborted;
        public bool Canceled;
        public string? Error;
        public double Elapsed;

        private static void Changed(TestRunChangedEventArgs? changed)
        {
            if (changed is null)
            {
                return;
            }
            if (changed.NewTestResults?.Any() == true)
            {
                Notify("results", new JsonObject { ["results"] = new JsonArray(changed.NewTestResults.Select(r => (JsonNode)Describe(r)).ToArray()) });
            }
            if (changed.ActiveTests?.Any() == true)
            {
                Notify("running", new JsonObject { ["tests"] = new JsonArray(changed.ActiveTests.Select(t => (JsonNode)Describe(t)).ToArray()) });
            }
        }

        public void HandleTestRunStatsChange(TestRunChangedEventArgs? testRunChangedArgs) => Changed(testRunChangedArgs);

        public void HandleTestRunComplete(TestRunCompleteEventArgs testRunCompleteArgs, TestRunChangedEventArgs? lastChunkArgs, ICollection<AttachmentSet>? runContextAttachments, ICollection<string>? executorUris)
        {
            Changed(lastChunkArgs);
            Aborted = testRunCompleteArgs.IsAborted;
            Canceled = testRunCompleteArgs.IsCanceled;
            Error = testRunCompleteArgs.Error?.Message;
            Elapsed = testRunCompleteArgs.ElapsedTimeInRunningTests.TotalMilliseconds;
            Done.Set();
        }

        public void HandleLogMessage(TestMessageLevel level, string? message) => Log(level, message);

        public void HandleRawMessage(string rawMessage)
        {
        }

        public int LaunchProcessWithDebuggerAttached(TestProcessStartInfo testProcessStartInfo) => new DebugLauncher().LaunchTestHost(testProcessStartInfo);
    }

    /// <summary>VSTest's way to debug, as Visual Studio's VsDebugTestHostLauncher: the test host vstest.console starts is
    /// attached to by the IDE's debugger, or the IDE starts the host under its debugger when VSTest asks it to.</summary>
    private sealed class DebugLauncher : ITestHostLauncher3
    {
        public bool IsDebug => true;

        public int LaunchTestHost(TestProcessStartInfo defaultTestHostStartInfo) => LaunchTestHost(defaultTestHostStartInfo, CancellationToken.None);

        public int LaunchTestHost(TestProcessStartInfo defaultTestHostStartInfo, CancellationToken cancellationToken)
        {
            JsonObject environment = [];
            foreach (var (name, value) in defaultTestHostStartInfo.EnvironmentVariables ?? new Dictionary<string, string?>())
            {
                environment[name] = value;
            }
            JsonNode? pid = Ask("launch", new JsonObject
            {
                ["file"] = defaultTestHostStartInfo.FileName,
                ["args"] = defaultTestHostStartInfo.Arguments,
                ["cwd"] = defaultTestHostStartInfo.WorkingDirectory,
                ["env"] = environment,
            });
            return pid is null ? -1 : (int)pid;
        }

        public bool AttachDebuggerToProcess(int pid) => AttachDebuggerToProcess(pid, CancellationToken.None);

        public bool AttachDebuggerToProcess(int pid, CancellationToken cancellationToken) =>
            (bool?)Ask("attach", new JsonObject { ["pid"] = pid }) ?? false;

        public bool AttachDebuggerToProcess(AttachDebuggerInfo attachDebuggerInfo, CancellationToken cancellationToken) =>
            (bool?)Ask("attach", new JsonObject
            {
                ["pid"] = attachDebuggerInfo.ProcessId,
                ["framework"] = attachDebuggerInfo.TargetFramework,
                ["sources"] = new JsonArray((attachDebuggerInfo.Sources ?? []).Select(s => (JsonNode?)s).ToArray()),
            }) ?? false;
    }
}
