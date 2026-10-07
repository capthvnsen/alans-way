// Read and drive a Windows desktop through UI Automation. Never moves the pointer.
// Build: csc.exe /nologo /target:exe /r:UIAutomationClient.dll /r:UIAutomationTypes.dll /r:WindowsBase.dll win-computer.cs
// Must stay C# 5: the in-box csc 4.0.30319 is the target compiler.
//
// Usage: win-computer serve      persistent, one JSON request per stdin line, one JSON response per stdout line
//        win-computer once       one request from stdin, one response, exit
//        win-computer selftest   pure-logic checks, no desktop needed
//        win-computer apps|snapshot|press|type|click|drag|shot ...   legacy argv, one-shot

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

class HelperError : Exception {
  public string Code;
  public HelperError(string code, string message) : base(message) { Code = code; }
}

static class WinComputer {
  const int DepthCap = 12;
  const int ElementCap = 180;
  const int NameCap = 120;
  const int ValueCap = 200;
  const int VisitCap = 5000;
  const int BudgetMs = 5000;
  const int DwmExtendedFrameBounds = 9;
  const int DwmCloaked = 14;
  const int ProcessQueryLimited = 0x1000;
  const int TokenQuery = 0x0008;
  const int TokenElevationClass = 20;
  const uint PrintFullContent = 2;
  const uint WmKeyDown = 0x0100, WmKeyUp = 0x0101, WmChar = 0x0102;
  const uint WmLButtonDown = 0x0201, WmLButtonUp = 0x0202, WmLButtonDblClk = 0x0203;
  const uint WmRButtonDown = 0x0204, WmRButtonUp = 0x0205, WmContextMenu = 0x007B;
  const uint GaRoot = 2;

  [StructLayout(LayoutKind.Sequential)]
  struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  [StructLayout(LayoutKind.Sequential)]
  struct POINT { public int X; public int Y; }

  [StructLayout(LayoutKind.Sequential)]
  struct GUITHREADINFO {
    public int cbSize; public int flags;
    public IntPtr hwndActive; public IntPtr hwndFocus; public IntPtr hwndCapture;
    public IntPtr hwndMenuOwner; public IntPtr hwndMoveSize; public IntPtr hwndCaret;
    public RECT rcCaret;
  }

  delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLength(IntPtr hwnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr hwnd, ref POINT point);
  [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint threadId, ref GUITHREADINFO info);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hwnd, int index);
  [DllImport("user32.dll")] static extern short VkKeyScan(char ch);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint mapType);
  [DllImport("shcore.dll")] static extern int SetProcessDpiAwareness(int awareness);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out RECT rect, int size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, int access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int infoClass, out int info, int size, out int needed);

  static readonly HashSet<ControlType> Interactive = new HashSet<ControlType> {
    ControlType.Button, ControlType.CheckBox, ControlType.ComboBox, ControlType.Document, ControlType.Edit,
    ControlType.Hyperlink, ControlType.ListItem, ControlType.MenuItem, ControlType.RadioButton,
    ControlType.ScrollBar, ControlType.Slider, ControlType.Spinner, ControlType.SplitButton,
    ControlType.TabItem, ControlType.TreeItem,
  };

  static readonly HashSet<ControlType> TextEntry = new HashSet<ControlType> {
    ControlType.Edit, ControlType.Document, ControlType.ComboBox,
  };

  static bool Readable(ControlType type) {
    return Interactive.Contains(type) || type == ControlType.Text;
  }

  class Top {
    public IntPtr Hwnd;
    public int Pid;
    public string Title = "";
    public bool Iconic;
    public RECT Frame;   // extended frame bounds (what the user sees), else the window rect
    public RECT Win;     // GetWindowRect, includes the invisible resize border
    public long Area { get { return (long)(Frame.Right - Frame.Left) * (Frame.Bottom - Frame.Top); } }
  }

  class App {
    public string Name = "";
    public int Pid;
    public bool Frontmost;
  }

  class Found {
    public AutomationElement Element;
    public ControlType Type;
    public string Role = "";
    public string Name = "";
    public string Value = "";
    public double X, Y, Width, Height;
    public bool Password;
  }

  class Node {
    public AutomationElement El;
    public int Depth;
    public List<int> Kids;
    public Found Item;
  }

  class Snap {
    public int Generation;
    public List<Found> Items = new List<Found>();
    public bool Truncated;
  }

  const int CacheMax = 16;
  const int GuardMs = 8000;
  static readonly Dictionary<int, Snap> cache = new Dictionary<int, Snap>();
  static readonly List<int> cacheOrder = new List<int>();
  static readonly Dictionary<int, Thread> hung = new Dictionary<int, Thread>();
  static CacheRequest walkCache;
  static Stream stdout;

  static HelperError Err(string code, string message) { return new HelperError(code, message); }

  // Without PerMonitorV2 awareness, UIA rects are logical pixels and screenshots physical.
  static void DpiAware() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch { }
    try { SetProcessDpiAwareness(2); return; } catch { }
    try { SetProcessDPIAware(); } catch { }
  }

  static bool Cloaked(IntPtr hwnd) {
    int value;
    return DwmGetWindowAttribute(hwnd, DwmCloaked, out value, sizeof(int)) == 0 && value != 0;
  }

  static string TitleOf(IntPtr hwnd) {
    int length = GetWindowTextLength(hwnd);
    if (length <= 0) return "";
    var builder = new StringBuilder(length + 1);
    GetWindowText(hwnd, builder, builder.Capacity);
    return builder.ToString();
  }

  static List<Top> Tops() {
    var tops = new List<Top>();
    EnumWindows(delegate (IntPtr hwnd, IntPtr lParam) {
      if (!IsWindowVisible(hwnd) || Cloaked(hwnd)) return true;
      uint pid;
      GetWindowThreadProcessId(hwnd, out pid);
      if (pid == 0) return true;
      RECT win;
      GetWindowRect(hwnd, out win);
      RECT frame;
      if (DwmGetWindowAttribute(hwnd, DwmExtendedFrameBounds, out frame, Marshal.SizeOf(typeof(RECT))) != 0) frame = win;
      tops.Add(new Top { Hwnd = hwnd, Pid = (int)pid, Title = TitleOf(hwnd), Iconic = IsIconic(hwnd), Frame = frame, Win = win });
      return true;
    }, IntPtr.Zero);
    return tops;
  }

  static int ForegroundPid() {
    IntPtr hwnd = GetForegroundWindow();
    if (hwnd == IntPtr.Zero) return 0;
    uint pid;
    GetWindowThreadProcessId(hwnd, out pid);
    return (int)pid;
  }

  class NameEntry {
    public DateTime Started;
    public string Name = "";
  }

  static readonly Dictionary<int, NameEntry> processNames = new Dictionary<int, NameEntry>();

  // Empty means the lookup failed; callers that gate access must treat that as blocked.
  // Cached per pid + start time so a reused pid never inherits an old process's name.
  static string ProcessName(int pid) {
    Process process;
    try { process = Process.GetProcessById(pid); } catch (Exception) { return ""; }
    try {
      DateTime started = DateTime.MinValue;
      bool haveStart = false;
      try { started = process.StartTime; haveStart = true; } catch (Exception) { }
      NameEntry entry;
      if (haveStart && processNames.TryGetValue(pid, out entry) && entry.Started == started) return entry.Name;
      string name = "";
      try { name = Path.GetFileName(process.MainModule.FileName) ?? ""; }
      // MainModule throws for elevated/protected processes — the ones the
      // .exe-suffixed blocklist targets — so keep the same filename shape.
      catch (Exception) {
        try { name = process.ProcessName; } catch (Exception) { name = ""; }
        if (name.Length > 0 && !name.EndsWith(".exe")) name += ".exe";
      }
      if (haveStart && name.Length > 0) {
        if (processNames.Count > 256) processNames.Clear();
        processNames[pid] = new NameEntry { Started = started, Name = name };
      }
      return name;
    } finally {
      process.Dispose();
    }
  }

  static List<App> Apps() {
    int front = ForegroundPid();
    var order = new List<int>();
    var titles = new Dictionary<int, string>();
    foreach (var top in Tops()) {
      string title;
      if (!titles.TryGetValue(top.Pid, out title)) { titles[top.Pid] = top.Title; order.Add(top.Pid); }
      else if (title.Length == 0 && top.Title.Length > 0) titles[top.Pid] = top.Title;
    }
    var apps = new List<App>();
    foreach (int pid in order) {
      var title = titles[pid];
      apps.Add(new App { Name = title.Length > 0 ? title : ProcessName(pid), Pid = pid, Frontmost = pid == front });
    }
    return apps;
  }

  // Admin windows are off limits: UIA silently refuses them below our integrity level.
  static bool Elevated(int pid) {
    IntPtr process = OpenProcess(ProcessQueryLimited, false, pid);
    if (process == IntPtr.Zero) return false;
    try {
      IntPtr token;
      if (!OpenProcessToken(process, TokenQuery, out token)) return false;
      try {
        int elevation, needed;
        return GetTokenInformation(token, TokenElevationClass, out elevation, sizeof(int), out needed) && elevation != 0;
      } finally { CloseHandle(token); }
    } finally { CloseHandle(process); }
  }

  static void CheckApp(int pid) {
    bool found = false;
    var live = new HashSet<int>();
    foreach (var top in Tops()) { live.Add(top.Pid); if (top.Pid == pid) found = true; }
    CachePrune(live);
    if (!found) throw Err("not_found", "App not found.");
    string name = ProcessName(pid);
    if (name.Length == 0 || Rules.Blocked(name) || Elevated(pid)) throw Err("off_limits", "That app is off limits.");
    int front = ForegroundPid();
    if (front == 0) throw Err("failed", "Could not see which window is in front.");
    if (front == pid) throw Err("in_front", "That app is the one in front. Leave it there; the pointer stays where it is.");
  }

  static double Clean(double value) {
    return double.IsNaN(value) || double.IsInfinity(value) ? 0 : value;
  }

  static CacheRequest WalkCache() {
    if (walkCache != null) return walkCache;
    var request = new CacheRequest();
    request.Add(AutomationElement.NameProperty);
    request.Add(AutomationElement.ControlTypeProperty);
    request.Add(AutomationElement.BoundingRectangleProperty);
    request.Add(AutomationElement.IsOffscreenProperty);
    request.Add(AutomationElement.IsEnabledProperty);
    request.Add(AutomationElement.IsPasswordProperty);
    request.Add(ValuePattern.Pattern);
    request.Add(ValuePattern.ValueProperty);
    request.Add(TogglePattern.Pattern);
    request.Add(TogglePattern.ToggleStateProperty);
    request.Add(RangeValuePattern.Pattern);
    request.Add(RangeValuePattern.ValueProperty);
    walkCache = request;
    return request;
  }

  static string Role(ControlType type) {
    const string prefix = "ControlType.";
    var name = type.ProgrammaticName;
    return name.StartsWith(prefix) ? name.Substring(prefix.Length) : name;
  }

  static string Cap(string text, int length) {
    return text.Length > length ? text.Substring(0, length) : text;
  }

  // Reads one node from the properties the cache request already fetched; null when it is offscreen or unreadable.
  static Found Read(AutomationElement element, out bool skip, out bool failed) {
    skip = false;
    failed = false;
    ControlType type;
    string name;
    bool offscreen, enabled, password;
    System.Windows.Rect bounds;
    try {
      AutomationElement.AutomationElementInformation cached = element.Cached;
      type = cached.ControlType;
      name = cached.Name ?? "";
      offscreen = cached.IsOffscreen;
      enabled = cached.IsEnabled;
      password = cached.IsPassword;
      bounds = cached.BoundingRectangle;
    } catch (UnauthorizedAccessException) {
      throw Err("off_limits", "That app is off limits.");
    } catch (Exception) {
      skip = true;
      failed = true;
      return null;
    }
    if (offscreen) { skip = true; return null; }
    var item = new Found {
      Element = element, Type = type, Role = Role(type), Password = password,
      X = Clean(bounds.X), Y = Clean(bounds.Y), Width = Math.Max(0, Clean(bounds.Width)), Height = Math.Max(0, Clean(bounds.Height)),
    };
    if (!Readable(type)) return item;
    object pattern;
    string value = "";
    try {
      if (TextEntry.Contains(type) && !password && element.TryGetCachedPattern(ValuePattern.Pattern, out pattern))
        value = ((ValuePattern)pattern).Cached.Value ?? "";
    } catch { }
    try {
      if ((type == ControlType.Slider || type == ControlType.ScrollBar || type == ControlType.Spinner)
          && element.TryGetCachedPattern(RangeValuePattern.Pattern, out pattern)) {
        var rounded = ((int)Math.Round(((RangeValuePattern)pattern).Cached.Value, MidpointRounding.AwayFromZero)).ToString(CultureInfo.InvariantCulture);
        name = name.Length == 0 ? rounded : name + " " + rounded;
      }
    } catch { }
    try {
      if (element.TryGetCachedPattern(TogglePattern.Pattern, out pattern))
        name += ((TogglePattern)pattern).Cached.ToggleState == ToggleState.On ? " on" : " off";
    } catch { }
    if (!enabled) name += name.Length == 0 ? "disabled" : " disabled";
    item.Name = Cap(name, NameCap);
    item.Value = Cap(value, ValueCap);
    return item;
  }

  // Breadth-first from every window of the app, so one huge window cannot starve the rest;
  // elements are emitted in document order afterwards.
  static Snap DoWalk(int pid) {
    var watch = Stopwatch.StartNew();
    var request = WalkCache();
    var nodes = new List<Node>();
    var roots = new List<int>();
    var queue = new Queue<int>();
    int attempted = 0;
    foreach (var top in Tops()) {
      if (top.Pid != pid) continue;
      attempted++;
      try {
        AutomationElement root;
        using (request.Activate()) { root = AutomationElement.FromHandle(top.Hwnd); }
        if (root == null) continue;
        nodes.Add(new Node { El = root, Depth = 0 });
        roots.Add(nodes.Count - 1);
        queue.Enqueue(nodes.Count - 1);
      } catch (UnauthorizedAccessException) {
        throw Err("off_limits", "That app is off limits.");
      } catch (Exception) { }
    }
    if (attempted > 0 && roots.Count == 0) throw Err("unresponsive", "That app is not responding.");
    int selected = 0, visited = 0;
    bool truncated = false;
    while (queue.Count > 0) {
      if (selected >= ElementCap || visited >= VisitCap || watch.ElapsedMilliseconds > BudgetMs) { truncated = true; break; }
      int index = queue.Dequeue();
      visited++;
      var node = nodes[index];
      bool skip, failed;
      Found item = Read(node.El, out skip, out failed);
      if (failed) truncated = true;
      if (skip) continue;
      if (Readable(item.Type)) { node.Item = item; selected++; }
      if (node.Depth >= DepthCap) continue;
      AutomationElementCollection kids = null;
      try {
        using (request.Activate()) { kids = node.El.FindAll(TreeScope.Children, Automation.ControlViewCondition); }
      } catch (UnauthorizedAccessException) {
        throw Err("off_limits", "That app is off limits.");
      } catch (Exception) { }
      if (kids == null) { truncated = true; continue; }
      node.Kids = new List<int>();
      foreach (AutomationElement kid in kids) {
        nodes.Add(new Node { El = kid, Depth = node.Depth + 1 });
        node.Kids.Add(nodes.Count - 1);
        queue.Enqueue(nodes.Count - 1);
      }
    }
    var snap = new Snap { Truncated = truncated };
    foreach (int root in roots) Collect(nodes, root, snap.Items);
    snap.Generation = Fingerprint(snap.Items);
    return snap;
  }

  static void Collect(List<Node> nodes, int index, List<Found> items) {
    var node = nodes[index];
    if (node.Item != null) items.Add(node.Item);
    if (node.Kids == null) return;
    foreach (int kid in node.Kids) Collect(nodes, kid, items);
  }

  static int Fingerprint(List<Found> items) {
    var lines = new List<string>();
    for (int i = 0; i < items.Count; i++) {
      var item = items[i];
      lines.Add(Gen.Line("c" + (i + 1), item.Role, item.Name, item.Value, true, item.X, item.Y, item.Width, item.Height));
    }
    return Gen.Of(lines);
  }

  static Dictionary<string, object> ElementJson(Found item, int index) {
    var json = new Dictionary<string, object>();
    json["ref"] = "c" + (index + 1);
    json["role"] = item.Role;
    json["name"] = item.Name;
    if (item.Value.Length > 0) json["value"] = item.Value;
    json["x"] = item.X;
    json["y"] = item.Y;
    json["width"] = item.Width;
    json["height"] = item.Height;
    return json;
  }

  static void AddSnapshot(Dictionary<string, object> response, Snap snap) {
    var elements = new List<object>();
    for (int i = 0; i < snap.Items.Count; i++) elements.Add(ElementJson(snap.Items[i], i));
    response["generation"] = snap.Generation;
    response["elements"] = elements;
    if (snap.Truncated) response["truncated"] = true;
  }

  static Snap CacheGet(int pid) {
    lock (cache) {
      Snap snap;
      return cache.TryGetValue(pid, out snap) ? snap : null;
    }
  }

  // Least recently used out beyond CacheMax; a late write from an abandoned walk is harmless.
  static void CachePut(int pid, Snap snap) {
    lock (cache) {
      cache[pid] = snap;
      cacheOrder.Remove(pid);
      cacheOrder.Add(pid);
      while (cacheOrder.Count > CacheMax) { cache.Remove(cacheOrder[0]); cacheOrder.RemoveAt(0); }
    }
  }

  static void CachePrune(HashSet<int> live) {
    lock (cache) {
      for (int i = cacheOrder.Count - 1; i >= 0; i--) {
        if (live.Contains(cacheOrder[i])) continue;
        cache.Remove(cacheOrder[i]);
        cacheOrder.RemoveAt(i);
      }
    }
  }

  static Snap Cached(int pid) {
    Snap snap = CacheGet(pid);
    if (snap == null) { snap = DoWalk(pid); CachePut(pid, snap); }
    return snap;
  }

  // Never trusts the cached generation: the tree is walked again and the cache replaced.
  static void EnsureGeneration(int pid, int generation) {
    Snap snap = DoWalk(pid);
    CachePut(pid, snap);
    if (snap.Generation != generation) throw Err("stale_ref", "stale_ref: The app changed since your snapshot. Take a fresh snapshot.");
  }

  static Found RefOf(int pid, string reference) {
    var snap = Cached(pid);
    int index;
    if (reference == null || reference.Length < 2 || reference[0] != 'c'
        || !int.TryParse(reference.Substring(1), NumberStyles.Integer, CultureInfo.InvariantCulture, out index)
        || index < 1 || index > snap.Items.Count)
      throw Err("stale_ref", "Unknown ref. Take a fresh snapshot.");
    var found = snap.Items[index - 1];
    try {
      found.Element.GetCurrentPropertyValue(AutomationElement.ProcessIdProperty);
    } catch (ElementNotAvailableException) {
      throw Err("stale_ref", "Unknown ref. Take a fresh snapshot.");
    } catch (Exception) { }
    return found;
  }

  static Found HitAt(List<Found> elements, double x, double y) {
    Found best = null;
    foreach (var element in elements) {
      if (!Interactive.Contains(element.Type) || element.Width <= 0 || element.Height <= 0) continue;
      if (x < element.X || x > element.X + element.Width || y < element.Y || y > element.Y + element.Height) continue;
      if (best == null || element.Width * element.Height < best.Width * best.Height) best = element;
    }
    return best;
  }

  static AutomationElement ParentOf(AutomationElement element) {
    try { return TreeWalker.ControlViewWalker.GetParent(element); } catch (Exception) { return null; }
  }

  // FromPoint catches controls outside the whitelist; the pid check keeps clicks inside the app.
  static AutomationElement ElementAtPoint(int pid, double x, double y) {
    AutomationElement element = null;
    try { element = AutomationElement.FromPoint(new System.Windows.Point(x, y)); } catch (Exception) { }
    for (int hops = 0; element != null && hops < 6; hops++) {
      try {
        if (element.Current.ProcessId == pid) return element;
      } catch (Exception) {
        return null;
      }
      element = ParentOf(element);
    }
    return null;
  }

  static Found HitAtPoint(int pid, double x, double y) {
    var hit = HitAt(Cached(pid).Items, x, y);
    if (hit != null) return hit;
    AutomationElement element = null;
    try { element = AutomationElement.FromPoint(new System.Windows.Point(x, y)); } catch (Exception) { }
    for (int hops = 0; element != null && hops < 6; hops++) {
      try {
        if (element.Current.ProcessId == pid && Interactive.Contains(element.Current.ControlType)) {
          var bounds = element.Current.BoundingRectangle;
          bool password = false;
          try { password = element.Current.IsPassword; } catch (Exception) { }
          return new Found {
            Element = element, Type = element.Current.ControlType, Password = password,
            X = Clean(bounds.X), Y = Clean(bounds.Y), Width = Clean(bounds.Width), Height = Clean(bounds.Height),
          };
        }
      } catch (Exception) {
        return null;
      }
      element = ParentOf(element);
    }
    return null;
  }

  static bool Invoke(AutomationElement element) {
    object pattern;
    try {
      if (element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) {
        ((InvokePattern)pattern).Invoke();
      } else if (element.TryGetCurrentPattern(TogglePattern.Pattern, out pattern)) {
        ((TogglePattern)pattern).Toggle();
      } else if (element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern)) {
        ((SelectionItemPattern)pattern).Select();
      } else if (element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern)) {
        var expand = (ExpandCollapsePattern)pattern;
        if (expand.Current.ExpandCollapseState == ExpandCollapseState.Expanded) expand.Collapse();
        else expand.Expand();
      } else {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  static string Str(Dictionary<string, object> map, string key) {
    object value;
    return map.TryGetValue(key, out value) && value is string ? (string)value : "";
  }

  static double Num(Dictionary<string, object> map, string key, double fallback) {
    object value;
    return map.TryGetValue(key, out value) && value is double ? (double)value : fallback;
  }

  static bool Has(Dictionary<string, object> map, string key) {
    object value;
    return map.TryGetValue(key, out value) && value != null;
  }

  static bool Flag(Dictionary<string, object> map, string key, bool fallback) {
    object value;
    return map.TryGetValue(key, out value) && value is bool ? (bool)value : fallback;
  }

  static int PidOf(Dictionary<string, object> req) {
    if (!Has(req, "pid") || !(req["pid"] is double)) throw Err("bad_request", "pid is required.");
    return (int)(double)req["pid"];
  }

  static Dictionary<string, object> Done() {
    var result = new Dictionary<string, object>();
    result["ok"] = true;
    result["cursorMoved"] = false;
    return result;
  }

  static Dictionary<string, object> Done(string via) {
    var result = Done();
    result["via"] = via;
    return result;
  }

  static void NoPassword(Found found) {
    if (found.Password) throw Err("off_limits", "Password fields are off limits.");
  }

  static Dictionary<string, object> StepPress(int pid, Dictionary<string, object> step) {
    var found = RefOf(pid, Str(step, "ref"));
    NoPassword(found);
    if (found.Type == ControlType.MenuItem) CheckFocus(pid, MainWindow(pid), IntPtr.Zero);
    if (!Interactive.Contains(found.Type)) throw Err("failed", "That control has no press action. Take a fresh snapshot.");
    if (Invoke(found.Element)) return Done("uia");
    var parent = ParentOf(found.Element);
    for (int hops = 0; parent != null && hops < 4; hops++) {
      if (Invoke(parent)) return Done("ancestor");
      parent = ParentOf(parent);
    }
    throw Err("failed", "Press failed.");
  }

  static Dictionary<string, object> StepClick(int pid, Dictionary<string, object> step) {
    var target = HitAtPoint(pid, Num(step, "x", 0), Num(step, "y", 0));
    if (target == null) throw Err("not_found", "No control at that point. Press a ref instead.");
    NoPassword(target);
    if (target.Type == ControlType.MenuItem) CheckFocus(pid, MainWindow(pid), IntPtr.Zero);
    if (!Invoke(target.Element)) throw Err("failed", "Press failed.");
    return Done("uia");
  }

  static Dictionary<string, object> StepType(int pid, Dictionary<string, object> step) {
    var found = RefOf(pid, Str(step, "ref"));
    NoPassword(found);
    string text = Str(step, "text");
    if (text.Length > 2000) throw Err("bad_request", "Text is too long.");
    object pattern;
    ValuePattern value = null;
    try {
      if (found.Element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) value = (ValuePattern)pattern;
    } catch { }
    if (value == null) throw Err("failed", "That control does not take text.");
    try {
      if (value.Current.IsReadOnly) throw Err("failed", "That control does not take text.");
      value.SetValue(text);
    } catch (HelperError) {
      throw;
    } catch {
      throw Err("failed", "That control does not take text.");
    }
    return Done("uia");
  }

  static Dictionary<string, object> StepDrag(int pid, Dictionary<string, object> step) {
    double x = Num(step, "x", 0), y = Num(step, "y", 0), x2 = Num(step, "x2", 0), y2 = Num(step, "y2", 0);
    var target = HitAt(Cached(pid).Items, x, y);
    if (target == null) throw Err("not_found", "No control at that point. Press a ref instead.");
    NoPassword(target);
    object pattern;
    RangeValuePattern range = null;
    try {
      if (target.Element.TryGetCurrentPattern(RangeValuePattern.Pattern, out pattern)) range = (RangeValuePattern)pattern;
    } catch { }
    if (range == null) throw Err("failed", "That control cannot be dragged. Press a ref instead.");
    try {
      bool horizontal = target.Width >= target.Height;
      double span = horizontal ? target.Width : target.Height;
      double origin = horizontal ? target.X : target.Y;
      double end = horizontal ? x2 : y2;
      double fraction = span <= 0 ? 0 : Math.Min(1, Math.Max(0, (end - origin) / span));
      range.SetValue(range.Current.Minimum + fraction * (range.Current.Maximum - range.Current.Minimum));
    } catch {
      throw Err("failed", "That control cannot be dragged. Press a ref instead.");
    }
    return Done("uia");
  }

  static IntPtr MainWindow(int pid) {
    Top best = null;
    foreach (var top in Tops()) {
      if (top.Pid != pid || top.Iconic) continue;
      if (best == null || top.Area > best.Area) best = top;
    }
    return best == null ? IntPtr.Zero : best.Hwnd;
  }

  // Element a ref, a point, or (neither given) the app's main window names.
  static AutomationElement TargetElement(int pid, Dictionary<string, object> step) {
    if (Has(step, "ref")) return RefOf(pid, Str(step, "ref")).Element;
    if (Has(step, "x") && Has(step, "y")) {
      var element = ElementAtPoint(pid, Num(step, "x", 0), Num(step, "y", 0));
      if (element == null) throw Err("not_found", "No control at that point. Press a ref instead.");
      return element;
    }
    IntPtr main = MainWindow(pid);
    if (main == IntPtr.Zero) throw Err("no_window", "That app has no window.");
    return AutomationElement.FromHandle(main);
  }

  static Dictionary<string, object> StepScroll(int pid, Dictionary<string, object> step) {
    string direction = Str(step, "direction");
    if (direction.Length == 0) direction = "down";
    bool vertical = direction == "up" || direction == "down";
    if (!vertical && direction != "left" && direction != "right") throw Err("bad_request", "direction must be up, down, left, or right.");
    bool forward = direction == "down" || direction == "right";
    double amount = Num(step, "amount", 1);
    if (amount <= 0) amount = 1;
    bool large = amount >= 1;
    int count = large ? (int)Math.Round(amount) : 1;
    if (count < 1) count = 1;
    if (count > 50) count = 50;
    ScrollAmount unit = forward
      ? (large ? ScrollAmount.LargeIncrement : ScrollAmount.SmallIncrement)
      : (large ? ScrollAmount.LargeDecrement : ScrollAmount.SmallDecrement);
    AutomationElement current = TargetElement(pid, step);
    for (int hops = 0; current != null && hops < 16; hops++) {
      try {
        object pattern;
        if (current.TryGetCurrentPattern(ScrollPattern.Pattern, out pattern)) {
          var scroll = (ScrollPattern)pattern;
          if (vertical ? scroll.Current.VerticallyScrollable : scroll.Current.HorizontallyScrollable) {
            double before = vertical ? scroll.Current.VerticalScrollPercent : scroll.Current.HorizontalScrollPercent;
            for (int i = 0; i < count; i++) {
              if (vertical) scroll.Scroll(ScrollAmount.NoAmount, unit);
              else scroll.Scroll(unit, ScrollAmount.NoAmount);
            }
            double after = vertical ? scroll.Current.VerticalScrollPercent : scroll.Current.HorizontalScrollPercent;
            var result = Done("uia");
            result["scrolled"] = before < 0 || after < 0 || Math.Abs(after - before) > 0.0001;
            return result;
          }
        }
      } catch (Exception) { }
      current = ParentOf(current);
    }
    throw Err("unsupported_action", "That control cannot scroll.");
  }

  // Nearest window handle the element or an ancestor owns; a top-level one cannot be clicked through messages.
  static IntPtr ChildWindowOf(AutomationElement element) {
    var current = element;
    for (int hops = 0; current != null && hops < 10; hops++) {
      try {
        int handle = current.Current.NativeWindowHandle;
        if (handle != 0) {
          var hwnd = new IntPtr(handle);
          return GetAncestor(hwnd, GaRoot) == hwnd ? IntPtr.Zero : hwnd;
        }
      } catch (Exception) {
        return IntPtr.Zero;
      }
      current = ParentOf(current);
    }
    return IntPtr.Zero;
  }

  // A window is a password field when UIA says so or it is an Edit with ES_PASSWORD.
  static bool PasswordWindow(IntPtr hwnd) {
    if (hwnd == IntPtr.Zero) return false;
    try {
      var cls = new StringBuilder(64);
      GetClassName(hwnd, cls, cls.Capacity);
      if (cls.ToString().IndexOf("edit", StringComparison.OrdinalIgnoreCase) >= 0 && (GetWindowLong(hwnd, -16) & 0x20) != 0) return true;
    } catch (Exception) { }
    try {
      var element = AutomationElement.FromHandle(hwnd);
      if (element != null && element.Current.IsPassword) return true;
    } catch (UnauthorizedAccessException) {
      return true;
    } catch (Exception) { }
    return false;
  }

  // Chromium, Electron and WPF keep the OS focus on one render host window, so the
  // field that really has focus is only visible through UI Automation.
  // Refuses the action unless the focused field is shown, within a time cap, to
  // be no password field. A password is off_limits; anything that cannot be read
  // (error, timeout, hung app, no window to search) is focus_unverified.
  static void CheckFocus(int pid, IntPtr top, IntPtr focusWindow) {
    int state = 2;
    var worker = new Thread(delegate() {
      try {
        if (PasswordWindow(focusWindow)) { state = 1; return; }
        var focused = AutomationElement.FocusedElement;
        if (focused != null && focused.Current.ProcessId == pid) { state = focused.Current.IsPassword ? 1 : 0; return; }
        if (top == IntPtr.Zero) return;
        var root = AutomationElement.FromHandle(top);
        var request = new CacheRequest();
        request.Add(AutomationElement.IsPasswordProperty);
        AutomationElement holder;
        using (request.Activate()) {
          holder = root.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.HasKeyboardFocusProperty, true));
        }
        state = holder != null && holder.Cached.IsPassword ? 1 : 0;
      } catch (Exception) { }
    });
    worker.IsBackground = true;
    worker.Start();
    bool finished = worker.Join(1500);
    if (finished && state == 1) throw Err("off_limits", "Password fields are off limits.");
    if (!finished || state != 0) throw Err("focus_unverified", "Could not verify which field has focus; retry or snapshot first.");
  }

  static IntPtr Long(int low, int high) {
    return new IntPtr((high << 16) | (low & 0xFFFF));
  }

  static Dictionary<string, object> StepMouse(int pid, Dictionary<string, object> step, bool right) {
    AutomationElement element;
    double cx, cy;
    if (Has(step, "ref")) {
      var found = RefOf(pid, Str(step, "ref"));
      NoPassword(found);
      element = found.Element;
      cx = found.X + found.Width / 2;
      cy = found.Y + found.Height / 2;
    } else {
      cx = Num(step, "x", 0);
      cy = Num(step, "y", 0);
      element = ElementAtPoint(pid, cx, cy);
      if (element == null) throw Err("not_found", "No control at that point. Press a ref instead.");
      try { if (element.Current.IsPassword) throw Err("off_limits", "Password fields are off limits."); }
      catch (HelperError) { throw; }
      catch (Exception) { }
    }
    bool inMenuItem = false;
    try { inMenuItem = element.Current.ControlType == ControlType.MenuItem; } catch (Exception) { }
    if (inMenuItem) CheckFocus(pid, MainWindow(pid), IntPtr.Zero);
    IntPtr hwnd = ChildWindowOf(element);
    string verb = right ? "right_click" : "double_click";
    if (hwnd == IntPtr.Zero) throw Err("unsupported_action", "Windows cannot " + verb + " this control without moving the pointer.");
    if (PasswordWindow(hwnd)) throw Err("off_limits", "Password fields are off limits.");
    var point = new POINT { X = (int)Math.Round(cx), Y = (int)Math.Round(cy) };
    ScreenToClient(hwnd, ref point);
    IntPtr at = Long(point.X, point.Y);
    if (right) {
      PostMessage(hwnd, WmRButtonDown, new IntPtr(2), at);
      PostMessage(hwnd, WmRButtonUp, IntPtr.Zero, at);
      PostMessage(hwnd, WmContextMenu, hwnd, Long((int)Math.Round(cx), (int)Math.Round(cy)));
    } else {
      PostMessage(hwnd, WmLButtonDown, new IntPtr(1), at);
      PostMessage(hwnd, WmLButtonUp, IntPtr.Zero, at);
      PostMessage(hwnd, WmLButtonDblClk, new IntPtr(1), at);
      PostMessage(hwnd, WmLButtonUp, IntPtr.Zero, at);
    }
    return Done("postmessage");
  }

  static bool VirtualKey(string key, out uint vk, out bool extended, out char character) {
    vk = 0; extended = false; character = '\0';
    switch (key) {
      case "return": vk = 0x0D; character = '\r'; return true;
      case "tab": vk = 0x09; character = '\t'; return true;
      case "space": vk = 0x20; character = ' '; return true;
      case "escape": vk = 0x1B; character = (char)27; return true;
      case "backspace": vk = 0x08; character = '\b'; return true;
      case "forwarddelete": vk = 0x2E; extended = true; return true;
      case "up": vk = 0x26; extended = true; return true;
      case "down": vk = 0x28; extended = true; return true;
      case "left": vk = 0x25; extended = true; return true;
      case "right": vk = 0x27; extended = true; return true;
      case "home": vk = 0x24; extended = true; return true;
      case "end": vk = 0x23; extended = true; return true;
      case "pageup": vk = 0x21; extended = true; return true;
      case "pagedown": vk = 0x22; extended = true; return true;
    }
    int number;
    if (key.Length >= 2 && key[0] == 'f' && int.TryParse(key.Substring(1), NumberStyles.Integer, CultureInfo.InvariantCulture, out number) && number >= 1 && number <= 12) {
      vk = (uint)(0x70 + number - 1);
      return true;
    }
    if (key.Length == 1) {
      character = key[0];
      short scan = VkKeyScan(character);
      if (scan != -1) vk = (uint)(scan & 0xFF);
      return true;
    }
    return false;
  }

  static Dictionary<string, object> StepKey(int pid, Dictionary<string, object> step) {
    var modifiers = step.ContainsKey("modifiers") ? step["modifiers"] as List<object> : null;
    string keyName = Str(step, "key");
    bool capital = false;
    if (modifiers != null && modifiers.Count > 0) {
      capital = modifiers.Count == 1 && (modifiers[0] as string) == "shift" && keyName.Length == 1 && char.IsLetter(keyName[0]);
      if (!capital) throw Err("unsupported_action", "Windows cannot send modified keys to a background app without taking focus.");
    }
    uint vk; bool extended; char character;
    if (!VirtualKey(keyName, out vk, out extended, out character)) throw Err("bad_request", "Unknown key.");
    if (capital) character = char.ToUpperInvariant(character);
    IntPtr top = MainWindow(pid);
    if (top == IntPtr.Zero) throw Err("no_window", "That app has no window.");
    uint pidOut;
    uint thread = GetWindowThreadProcessId(top, out pidOut);
    var info = new GUITHREADINFO();
    info.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
    IntPtr target = GetGUIThreadInfo(thread, ref info) && info.hwndFocus != IntPtr.Zero ? info.hwndFocus : top;
    CheckFocus(pid, top, target);
    long scan = vk == 0 ? 0 : MapVirtualKey(vk, 0);
    long down = 1 | (scan << 16) | (extended ? (1L << 24) : 0);
    long up = down | (1L << 30) | (1L << 31);
    if (vk != 0) PostMessage(target, WmKeyDown, new IntPtr((long)vk), new IntPtr(down));
    if (character != '\0') PostMessage(target, WmChar, new IntPtr((int)character), new IntPtr(down));
    if (vk != 0) PostMessage(target, WmKeyUp, new IntPtr((long)vk), new IntPtr(up));
    return Done("postmessage");
  }

  static bool IsMenuHost(ControlType type) {
    return type == ControlType.MenuBar || type == ControlType.Menu;
  }

  static AutomationElement MenuBarOf(int pid) {
    var watch = Stopwatch.StartNew();
    foreach (var top in Tops()) {
      if (top.Pid != pid) continue;
      AutomationElement root;
      try { root = AutomationElement.FromHandle(top.Hwnd); }
      catch (UnauthorizedAccessException) { throw Err("off_limits", "That app is off limits."); }
      catch (Exception) { continue; }
      if (root == null) continue;
      var level = new List<AutomationElement>();
      level.Add(root);
      for (int depth = 0; depth < 4 && level.Count > 0 && watch.ElapsedMilliseconds < 3000; depth++) {
        var next = new List<AutomationElement>();
        foreach (var element in level) {
          AutomationElementCollection kids;
          try { kids = element.FindAll(TreeScope.Children, Automation.ControlViewCondition); }
          catch (Exception) { continue; }
          foreach (AutomationElement kid in kids) {
            ControlType type;
            try { type = kid.Current.ControlType; } catch (Exception) { continue; }
            if (IsMenuHost(type)) return kid;
            next.Add(kid);
          }
        }
        level = next;
      }
    }
    return null;
  }

  static List<AutomationElement> MenuItemsUnder(AutomationElement parent) {
    var items = new List<AutomationElement>();
    try {
      var kids = parent.FindAll(TreeScope.Children, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.MenuItem));
      foreach (AutomationElement kid in kids) items.Add(kid);
      if (items.Count > 0) return items;
      var menus = parent.FindAll(TreeScope.Children, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Menu));
      foreach (AutomationElement menu in menus) {
        var inner = menu.FindAll(TreeScope.Children, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.MenuItem));
        foreach (AutomationElement kid in inner) items.Add(kid);
      }
    } catch (Exception) { }
    return items;
  }

  // Win32 popup menus open as their own top-level window of the same process.
  static List<AutomationElement> PopupMenuItems(int pid) {
    var items = new List<AutomationElement>();
    foreach (var top in Tops()) {
      if (top.Pid != pid) continue;
      try {
        var root = AutomationElement.FromHandle(top.Hwnd);
        if (root != null && root.Current.ControlType == ControlType.Menu) items.AddRange(MenuItemsUnder(root));
      } catch (Exception) { }
    }
    return items;
  }

  static string TitleOfItem(AutomationElement item) {
    try { return item.Current.Name ?? ""; } catch (Exception) { return ""; }
  }

  static bool OpenMenu(AutomationElement item) {
    object pattern;
    try {
      if (item.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern)) { ((ExpandCollapsePattern)pattern).Expand(); return true; }
      if (item.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) { ((InvokePattern)pattern).Invoke(); return true; }
    } catch (Exception) { }
    return false;
  }

  static void CollapseAll(List<AutomationElement> opened) {
    for (int i = opened.Count - 1; i >= 0; i--) {
      try {
        object pattern;
        if (opened[i].TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern)) ((ExpandCollapsePattern)pattern).Collapse();
      } catch (Exception) { }
    }
  }

  // Walks the menu path title by title; presses the last item or lists its children.
  static Dictionary<string, object> MenuWalk(int pid, List<string> path, bool press) {
    var bar = MenuBarOf(pid);
    if (bar == null) throw Err("unsupported_action", "This app exposes no menu bar.");
    var opened = new List<AutomationElement>();
    try {
      var level = MenuItemsUnder(bar);
      for (int i = 0; i < path.Count; i++) {
        string want = Rules.NormTitle(path[i]);
        AutomationElement hit = null;
        foreach (var item in level) if (Rules.NormTitle(TitleOfItem(item)) == want) { hit = item; break; }
        if (hit == null) throw Err("not_found", "No such menu item.");
        if (press && i == path.Count - 1) {
          bool enabled = true;
          try { enabled = hit.Current.IsEnabled; } catch (Exception) { }
          if (!enabled) throw Err("failed", "That menu item is disabled.");
          if (!Invoke(hit)) throw Err("failed", "Press failed.");
          return Done("uia");
        }
        if (!OpenMenu(hit)) throw Err("failed", "Could not open that menu.");
        opened.Add(hit);
        Thread.Sleep(80);
        level = MenuItemsUnder(hit);
        if (level.Count == 0) level = PopupMenuItems(pid);
      }
      var list = new List<object>();
      foreach (var item in level) {
        var entry = new Dictionary<string, object>();
        string title = TitleOfItem(item);
        string shortcut = "";
        int tab = title.IndexOf('\t');
        if (tab >= 0) { shortcut = title.Substring(tab + 1).Trim(); title = title.Substring(0, tab); }
        bool enabled = true;
        try {
          enabled = item.Current.IsEnabled;
          if (shortcut.Length == 0) shortcut = item.Current.AcceleratorKey ?? "";
        } catch (Exception) { }
        entry["title"] = title.Replace("&", "");
        entry["enabled"] = enabled;
        if (shortcut.Length > 0) entry["shortcut"] = shortcut;
        object pattern;
        try { if (item.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern)) entry["submenu"] = true; } catch (Exception) { }
        list.Add(entry);
      }
      var response = new Dictionary<string, object>();
      response["ok"] = true;
      response["items"] = list;
      return response;
    } finally {
      CollapseAll(opened);
    }
  }

  static Dictionary<string, object> StepMenu(int pid, Dictionary<string, object> step) {
    var path = StringList(step, "path");
    if (path.Count == 0) throw Err("bad_request", "menu needs a path.");
    CheckFocus(pid, MainWindow(pid), IntPtr.Zero);
    return MenuWalk(pid, path, true);
  }

  static List<string> StringList(Dictionary<string, object> map, string key) {
    var list = new List<string>();
    object value;
    if (map.TryGetValue(key, out value)) {
      var items = value as List<object>;
      if (items != null) foreach (object item in items) if (item is string) list.Add((string)item);
    }
    return list;
  }

  static Dictionary<string, object> RunStep(int pid, Dictionary<string, object> step) {
    switch (Str(step, "action")) {
      case "press": return StepPress(pid, step);
      case "click": return StepClick(pid, step);
      case "type": return StepType(pid, step);
      case "drag": return StepDrag(pid, step);
      case "double_click": return StepMouse(pid, step, false);
      case "right_click": return StepMouse(pid, step, true);
      case "scroll": return StepScroll(pid, step);
      case "key": return StepKey(pid, step);
      case "menu": return StepMenu(pid, step);
    }
    throw Err("unsupported_action", "Unsupported action " + Str(step, "action") + ".");
  }

  static Dictionary<string, object> Failure(string code, string message) {
    var result = new Dictionary<string, object>();
    result["ok"] = false;
    result["error"] = message;
    result["code"] = code;
    return result;
  }

  static Dictionary<string, object> CmdApps() {
    var list = new List<object>();
    foreach (var app in Apps()) {
      var entry = new Dictionary<string, object>();
      entry["name"] = app.Name;
      entry["bundleId"] = ProcessName(app.Pid);
      entry["pid"] = app.Pid;
      entry["frontmost"] = app.Frontmost;
      list.Add(entry);
    }
    var response = new Dictionary<string, object>();
    response["ok"] = true;
    response["apps"] = list;
    return response;
  }

  static Dictionary<string, object> CmdSnapshot(Dictionary<string, object> req) {
    int pid = PidOf(req);
    CheckApp(pid);
    var snap = DoWalk(pid);
    CachePut(pid, snap);
    var response = new Dictionary<string, object>();
    response["ok"] = true;
    AddSnapshot(response, snap);
    return response;
  }

  static Dictionary<string, object> CmdAct(Dictionary<string, object> req) {
    int pid = PidOf(req);
    CheckApp(pid);
    var steps = req.ContainsKey("steps") ? req["steps"] as List<object> : null;
    if (steps == null || steps.Count == 0) throw Err("bad_request", "act needs steps.");
    bool needsRef = false;
    foreach (object item in steps) {
      var step = item as Dictionary<string, object>;
      if (step == null) throw Err("bad_request", "Each step must be an object.");
      string action = Str(step, "action");
      if (action == "press" || action == "type" || ((action == "double_click" || action == "right_click" || action == "scroll") && Has(step, "ref"))) needsRef = true;
    }
    if (needsRef && Has(req, "generation") && req["generation"] is double) EnsureGeneration(pid, (int)(double)req["generation"]);
    var results = new List<object>();
    bool anyOk = false;
    foreach (object item in steps) {
      try {
        results.Add(RunStep(pid, (Dictionary<string, object>)item));
        anyOk = true;
      } catch (HelperError error) {
        results.Add(Failure(error.Code, error.Message));
        break;
      } catch (UnauthorizedAccessException) {
        results.Add(Failure("off_limits", "That app is off limits."));
        break;
      } catch (Exception error) {
        results.Add(Failure("failed", error.Message.Length > 0 ? error.Message : "Desktop helper failed."));
        break;
      }
    }
    var response = new Dictionary<string, object>();
    response["ok"] = true;
    response["results"] = results;
    if (Flag(req, "snapshot", true) && anyOk) {
      Thread.Sleep((int)Math.Max(0, Math.Min(2000, Num(req, "settleMs", 60))));
      // The steps already ran; a tree that cannot be read afterwards must not hide their results.
      try {
        var snap = DoWalk(pid);
        CachePut(pid, snap);
        AddSnapshot(response, snap);
      } catch (Exception) {
        response["note"] = "unresponsive: the steps ran but the app stopped responding, so there is no tree. Do not repeat them; take a fresh snapshot.";
      }
    }
    return response;
  }

  static Dictionary<string, object> CmdMenu(Dictionary<string, object> req) {
    int pid = PidOf(req);
    CheckApp(pid);
    return MenuWalk(pid, StringList(req, "path"), false);
  }

  static Dictionary<string, object> CmdShot(Dictionary<string, object> req) {
    int pid = PidOf(req);
    int cap = (int)Math.Min(Math.Max(Num(req, "maxWidth", 960), 320), 1280);
    CheckApp(pid);
    Top best = null;
    foreach (var top in Tops()) {
      if (top.Pid != pid || top.Iconic) continue;
      int width = top.Frame.Right - top.Frame.Left, height = top.Frame.Bottom - top.Frame.Top;
      if (width < 1 || height < 1) continue;
      if (best == null || top.Area > best.Area) best = top;
    }
    if (best == null) throw Err("no_window", "That app has no window to capture.");
    // PrintWindow draws the whole GetWindowRect window, invisible resize border included; crop to
    // the extended frame so the bitmap, its origin and the reported rect are all the same rectangle.
    int winWidth = best.Win.Right - best.Win.Left, winHeight = best.Win.Bottom - best.Win.Top;
    if (winWidth < 1 || winHeight < 1) throw Err("no_window", "That app has no window to capture.");
    Bitmap bitmap = new Bitmap(winWidth, winHeight, PixelFormat.Format24bppRgb);
    using (var graphics = Graphics.FromImage(bitmap)) {
      IntPtr hdc = graphics.GetHdc();
      bool drawn = PrintWindow(best.Hwnd, hdc, PrintFullContent) || PrintWindow(best.Hwnd, hdc, 0);
      graphics.ReleaseHdc(hdc);
      if (!drawn) {
        bitmap.Dispose();
        throw Err("failed", "Could not capture that window.");
      }
    }
    int cropX = Math.Max(0, best.Frame.Left - best.Win.Left), cropY = Math.Max(0, best.Frame.Top - best.Win.Top);
    int frameWidth = Math.Min(best.Frame.Right - best.Frame.Left, winWidth - cropX);
    int frameHeight = Math.Min(best.Frame.Bottom - best.Frame.Top, winHeight - cropY);
    if (frameWidth < 1 || frameHeight < 1) { cropX = 0; cropY = 0; frameWidth = winWidth; frameHeight = winHeight; }
    if (cropX != 0 || cropY != 0 || frameWidth != winWidth || frameHeight != winHeight) {
      var cropped = bitmap.Clone(new Rectangle(cropX, cropY, frameWidth, frameHeight), PixelFormat.Format24bppRgb);
      bitmap.Dispose();
      bitmap = cropped;
    }
    if (frameWidth > cap) {
      int scaledWidth = cap, scaledHeight = Math.Max(1, (int)Math.Round(frameHeight * (double)cap / frameWidth));
      var scaled = new Bitmap(scaledWidth, scaledHeight, PixelFormat.Format24bppRgb);
      using (var graphics = Graphics.FromImage(scaled)) {
        graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
        graphics.DrawImage(bitmap, 0, 0, scaledWidth, scaledHeight);
      }
      bitmap.Dispose();
      bitmap = scaled;
    }
    ImageCodecInfo jpeg = null;
    foreach (var codec in ImageCodecInfo.GetImageEncoders()) if (codec.MimeType == "image/jpeg") jpeg = codec;
    var quality = new EncoderParameters(1);
    quality.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 55L);
    var stream = new MemoryStream();
    bitmap.Save(stream, jpeg, quality);
    var response = new Dictionary<string, object>();
    response["ok"] = true;
    response["image"] = Convert.ToBase64String(stream.ToArray());
    response["imageWidth"] = bitmap.Width;
    response["imageHeight"] = bitmap.Height;
    response["windowX"] = best.Win.Left + cropX;
    response["windowY"] = best.Win.Top + cropY;
    response["windowWidth"] = frameWidth;
    response["windowHeight"] = frameHeight;
    bitmap.Dispose();
    return response;
  }

  // Runs a UIA / window-message command on a worker so a hung app cannot freeze the helper.
  // The abandoned worker is remembered; its pid is refused until it finishes.
  static Dictionary<string, object> Guarded(int pid, int extraMs, Func<Dictionary<string, object>> body) {
    lock (hung) {
      Thread old;
      if (hung.TryGetValue(pid, out old)) {
        if (old.IsAlive) throw Err("unresponsive", "That app is not responding.");
        hung.Remove(pid);
      }
    }
    Dictionary<string, object> result = null;
    Exception failure = null;
    var worker = new Thread(delegate () {
      Thread.CurrentThread.CurrentCulture = CultureInfo.InvariantCulture;
      try { result = body(); } catch (Exception error) { failure = error; }
    });
    worker.IsBackground = true;
    worker.Start();
    if (!worker.Join(GuardMs + extraMs)) {
      lock (hung) { hung[pid] = worker; }
      throw Err("unresponsive", "That app is not responding.");
    }
    if (failure != null) throw failure;
    return result;
  }

  static Dictionary<string, object> Handle(Dictionary<string, object> req) {
    Dictionary<string, object> response;
    try {
      if (req.ContainsKey("policy")) Rules.Set(req["policy"]);
      switch (Str(req, "cmd")) {
        case "init": response = new Dictionary<string, object>(); response["ok"] = true; response["protocol"] = 2; break;
        case "apps": response = CmdApps(); break;
        case "snapshot": response = Guarded(PidOf(req), 0, delegate () { return CmdSnapshot(req); }); break;
        case "act": response = Guarded(PidOf(req), (int)Math.Max(0, Math.Min(2000, Num(req, "settleMs", 60))), delegate () { return CmdAct(req); }); break;
        case "menu": response = Guarded(PidOf(req), 0, delegate () { return CmdMenu(req); }); break;
        case "shot": response = Guarded(PidOf(req), 0, delegate () { return CmdShot(req); }); break;
        case "selftest": response = new Dictionary<string, object>(); response["ok"] = true; response["checks"] = SelfTest.Run(); break;
        default: throw Err("bad_request", "unknown command " + Str(req, "cmd"));
      }
    } catch (HelperError error) {
      response = Failure(error.Code, error.Message);
    } catch (UnauthorizedAccessException) {
      response = Failure("off_limits", "That app is off limits.");
    } catch (Exception error) {
      response = Failure("failed", error.Message.Length > 0 ? error.Message : "Desktop helper failed.");
    }
    object id;
    response["id"] = req.TryGetValue("id", out id) ? id : null;
    return response;
  }

  static string HandleLine(string line) {
    Dictionary<string, object> req = null;
    try { req = Js.Parse(line) as Dictionary<string, object>; } catch (Exception) { }
    Dictionary<string, object> response = req == null ? Failure("bad_request", "Request must be a JSON object.") : Handle(req);
    return Js.Write(response);
  }

  static void WriteLine(string text) {
    if (stdout == null) stdout = Console.OpenStandardOutput();
    // Js.Write escapes everything outside printable ASCII, so ASCII bytes are exact.
    byte[] bytes = Encoding.ASCII.GetBytes(text + "\n");
    stdout.Write(bytes, 0, bytes.Length);
    stdout.Flush();
  }

  static StreamReader Input() {
    return new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
  }

  static int Serve() {
    var input = Input();
    string line;
    while ((line = input.ReadLine()) != null) {
      if (line.Trim().Length == 0) continue;
      WriteLine(HandleLine(line));
    }
    return 0;
  }

  static int Once() {
    string line = Input().ReadLine();
    string reply = line == null ? Js.Write(Failure("bad_request", "missing request")) : HandleLine(line);
    WriteLine(reply);
    return reply.StartsWith("{\"ok\":true") ? 0 : 1;
  }

  static List<object> Steps(Dictionary<string, object> step) {
    var steps = new List<object>();
    steps.Add(step);
    return steps;
  }

  static Dictionary<string, object> Step(string action, string reference) {
    var step = new Dictionary<string, object>();
    step["action"] = action;
    if (reference != null) step["ref"] = reference;
    return step;
  }

  static bool ArgNum(string[] args, int index, string key, Dictionary<string, object> into) {
    double value;
    if (args.Length <= index || !double.TryParse(args[index], NumberStyles.Float, CultureInfo.InvariantCulture, out value)) return false;
    into[key] = value;
    return true;
  }

  // Old argv commands become protocol requests; an act reply is flattened to its single step result.
  static int Legacy(string[] args) {
    var req = new Dictionary<string, object>();
    string command = args[0];
    double pid;
    if (command != "apps") {
      if (args.Length < 2 || !double.TryParse(args[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out pid)) {
        WriteLine(Js.Write(Failure("bad_request", command + " needs a pid")));
        return 1;
      }
      req["pid"] = pid;
    }
    bool flatten = false;
    Dictionary<string, object> step = null;
    switch (command) {
      case "apps": req["cmd"] = "apps"; break;
      case "snapshot": req["cmd"] = "snapshot"; break;
      case "shot":
        req["cmd"] = "shot";
        ArgNum(args, 2, "maxWidth", req);
        break;
      case "press":
        if (args.Length < 3) { WriteLine(Js.Write(Failure("bad_request", "press needs a pid and a ref"))); return 1; }
        step = Step("press", args[2]);
        break;
      case "type":
        if (args.Length < 4) { WriteLine(Js.Write(Failure("bad_request", "type needs a pid, a ref, and text"))); return 1; }
        step = Step("type", args[2]);
        step["text"] = args[3];
        break;
      case "click":
        step = Step("click", null);
        if (!ArgNum(args, 2, "x", step) || !ArgNum(args, 3, "y", step)) { WriteLine(Js.Write(Failure("bad_request", "click needs pid x y"))); return 1; }
        break;
      case "drag":
        step = Step("drag", null);
        if (!ArgNum(args, 2, "x", step) || !ArgNum(args, 3, "y", step)) { WriteLine(Js.Write(Failure("bad_request", "drag needs pid x y"))); return 1; }
        if (!ArgNum(args, 4, "x2", step) || !ArgNum(args, 5, "y2", step)) { WriteLine(Js.Write(Failure("bad_request", "drag needs x2 y2"))); return 1; }
        break;
      default:
        WriteLine(Js.Write(Failure("bad_request", "unknown command " + command)));
        return 1;
    }
    if (step != null) {
      req["cmd"] = "act";
      req["steps"] = Steps(step);
      req["snapshot"] = false;
      flatten = true;
    }
    var response = Handle(req);
    if (flatten && response.ContainsKey("results")) {
      var results = (List<object>)response["results"];
      if (results.Count > 0) response = (Dictionary<string, object>)results[0];
    }
    response.Remove("id");
    WriteLine(Js.Write(response));
    return response.ContainsKey("ok") && response["ok"] is bool && (bool)response["ok"] ? 0 : 1;
  }

  static int Main(string[] args) {
    Thread.CurrentThread.CurrentCulture = CultureInfo.InvariantCulture;
    DpiAware();
    try {
      if (args.Length == 0) { WriteLine(Js.Write(Failure("bad_request", "missing command"))); return 1; }
      switch (args[0]) {
        case "serve": return Serve();
        case "once": return Once();
        case "selftest": {
          var req = new Dictionary<string, object>();
          req["cmd"] = "selftest";
          string reply = Js.Write(Handle(req));
          WriteLine(reply);
          return reply.StartsWith("{\"ok\":true") ? 0 : 1;
        }
        default: return Legacy(args);
      }
    } catch (Exception error) {
      WriteLine(Js.Write(Failure("failed", error.Message.Length > 0 ? error.Message : "Desktop helper failed.")));
      return 1;
    }
  }
}

// <pure>
// Everything below touches no desktop API, so selftest (and a throwaway harness) can run it anywhere.

static class Js {
  public static object Parse(string text) {
    int i = 0;
    object value = ReadValue(text, ref i);
    SkipSpace(text, ref i);
    if (i != text.Length) throw new FormatException("Trailing data.");
    return value;
  }

  static void SkipSpace(string s, ref int i) {
    while (i < s.Length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++;
  }

  static void Expect(string s, ref int i, char c) {
    SkipSpace(s, ref i);
    if (i >= s.Length || s[i] != c) throw new FormatException("Expected " + c);
    i++;
  }

  static object ReadValue(string s, ref int i) {
    SkipSpace(s, ref i);
    if (i >= s.Length) throw new FormatException("Unexpected end.");
    char c = s[i];
    if (c == '{') {
      i++;
      var map = new Dictionary<string, object>();
      SkipSpace(s, ref i);
      if (i < s.Length && s[i] == '}') { i++; return map; }
      while (true) {
        SkipSpace(s, ref i);
        string key = ReadString(s, ref i);
        Expect(s, ref i, ':');
        map[key] = ReadValue(s, ref i);
        SkipSpace(s, ref i);
        if (i >= s.Length) throw new FormatException("Unexpected end.");
        if (s[i] == ',') { i++; continue; }
        if (s[i] == '}') { i++; return map; }
        throw new FormatException("Expected , or }");
      }
    }
    if (c == '[') {
      i++;
      var list = new List<object>();
      SkipSpace(s, ref i);
      if (i < s.Length && s[i] == ']') { i++; return list; }
      while (true) {
        list.Add(ReadValue(s, ref i));
        SkipSpace(s, ref i);
        if (i >= s.Length) throw new FormatException("Unexpected end.");
        if (s[i] == ',') { i++; continue; }
        if (s[i] == ']') { i++; return list; }
        throw new FormatException("Expected , or ]");
      }
    }
    if (c == '"') return ReadString(s, ref i);
    if (String.CompareOrdinal(s, i, "true", 0, 4) == 0) { i += 4; return true; }
    if (String.CompareOrdinal(s, i, "false", 0, 5) == 0) { i += 5; return false; }
    if (String.CompareOrdinal(s, i, "null", 0, 4) == 0) { i += 4; return null; }
    int start = i;
    while (i < s.Length && "+-0123456789.eE".IndexOf(s[i]) >= 0) i++;
    double number;
    if (i == start || !double.TryParse(s.Substring(start, i - start), NumberStyles.Float, CultureInfo.InvariantCulture, out number))
      throw new FormatException("Bad value.");
    return number;
  }

  static string ReadString(string s, ref int i) {
    if (i >= s.Length || s[i] != '"') throw new FormatException("Expected string.");
    i++;
    var builder = new StringBuilder();
    while (true) {
      if (i >= s.Length) throw new FormatException("Unterminated string.");
      char c = s[i++];
      if (c == '"') return builder.ToString();
      if (c != '\\') { builder.Append(c); continue; }
      if (i >= s.Length) throw new FormatException("Unterminated string.");
      char e = s[i++];
      switch (e) {
        case 'n': builder.Append('\n'); break;
        case 'r': builder.Append('\r'); break;
        case 't': builder.Append('\t'); break;
        case 'b': builder.Append('\b'); break;
        case 'f': builder.Append('\f'); break;
        case 'u':
          if (i + 4 > s.Length) throw new FormatException("Bad escape.");
          builder.Append((char)int.Parse(s.Substring(i, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
          i += 4;
          break;
        default: builder.Append(e); break;
      }
    }
  }

  public static string Write(object value) {
    var builder = new StringBuilder();
    WriteValue(value, builder);
    return builder.ToString();
  }

  static void WriteValue(object value, StringBuilder json) {
    if (value == null) { json.Append("null"); return; }
    string text = value as string;
    if (text != null) { WriteString(text, json); return; }
    if (value is bool) { json.Append((bool)value ? "true" : "false"); return; }
    if (value is int) { json.Append(((int)value).ToString(CultureInfo.InvariantCulture)); return; }
    if (value is long) { json.Append(((long)value).ToString(CultureInfo.InvariantCulture)); return; }
    if (value is double) {
      double number = (double)value;
      if (double.IsNaN(number) || double.IsInfinity(number)) json.Append("0");
      else if (number == Math.Floor(number) && Math.Abs(number) < 1e15) json.Append(((long)number).ToString(CultureInfo.InvariantCulture));
      else json.Append(number.ToString("r", CultureInfo.InvariantCulture));
      return;
    }
    var map = value as Dictionary<string, object>;
    if (map != null) {
      json.Append('{');
      bool first = true;
      foreach (var pair in map) {
        if (!first) json.Append(',');
        first = false;
        WriteString(pair.Key, json);
        json.Append(':');
        WriteValue(pair.Value, json);
      }
      json.Append('}');
      return;
    }
    var list = value as List<object>;
    if (list != null) {
      json.Append('[');
      for (int i = 0; i < list.Count; i++) {
        if (i > 0) json.Append(',');
        WriteValue(list[i], json);
      }
      json.Append(']');
      return;
    }
    throw new InvalidOperationException("Cannot serialize " + value.GetType().Name);
  }

  static void WriteString(string value, StringBuilder json) {
    json.Append('"');
    foreach (char c in value) {
      switch (c) {
        case '"': json.Append("\\\""); break;
        case '\\': json.Append("\\\\"); break;
        case '\b': json.Append("\\b"); break;
        case '\f': json.Append("\\f"); break;
        case '\n': json.Append("\\n"); break;
        case '\r': json.Append("\\r"); break;
        case '\t': json.Append("\\t"); break;
        default:
          if (c < ' ' || c > '~') json.Append("\\u").Append(((int)c).ToString("x4"));
          else json.Append(c);
          break;
      }
    }
    json.Append('"');
  }
}

static class Gen {
  static string Round(double value) {
    if (double.IsNaN(value) || double.IsInfinity(value)) return "0";
    return ((long)Math.Floor(value + 0.5)).ToString(CultureInfo.InvariantCulture);
  }

  public static string Line(string reference, string role, string name, string value, bool hasBox, double x, double y, double width, double height) {
    string box = hasBox ? Round(x) + "|" + Round(y) + "|" + Round(width) + "|" + Round(height) : "|||";
    return reference + "|" + role + "|" + name + "|" + value + "|" + box;
  }

  public static int Fnv(string text) {
    uint hash = 0x811C9DC5;
    foreach (byte b in Encoding.UTF8.GetBytes(text)) {
      hash ^= b;
      hash = unchecked(hash * 0x01000193);
    }
    return (int)(hash & 0x7fffffff);
  }

  public static int Of(List<string> lines) {
    return Fnv(string.Join("\n", lines.ToArray()));
  }
}

static class Rules {
  static HashSet<string> exact = new HashSet<string>();
  static List<string> contains = new List<string>();

  public static void Set(object policy) {
    var map = policy as Dictionary<string, object>;
    var nextExact = new HashSet<string>();
    var nextContains = new List<string>();
    if (map != null) {
      object value;
      if (map.TryGetValue("exact", out value) && value is List<object>)
        foreach (object item in (List<object>)value) if (item is string) nextExact.Add(((string)item).ToLowerInvariant());
      if (map.TryGetValue("contains", out value) && value is List<object>)
        foreach (object item in (List<object>)value) if (item is string && ((string)item).Length > 0) nextContains.Add(((string)item).ToLowerInvariant());
    }
    exact = nextExact;
    contains = nextContains;
  }

  public static bool Blocked(string id) {
    string lower = (id ?? "").ToLowerInvariant();
    if (lower.Length == 0) return false;
    if (exact.Contains(lower)) return true;
    foreach (string part in contains) if (lower.IndexOf(part, StringComparison.Ordinal) >= 0) return true;
    return false;
  }

  // Menu titles compare without accelerator marks, shortcut text, trailing ellipsis or case.
  public static string NormTitle(string title) {
    string text = title ?? "";
    int tab = text.IndexOf('\t');
    if (tab >= 0) text = text.Substring(0, tab);
    text = text.Replace("&", "").Trim();
    while (text.EndsWith("…")) text = text.Substring(0, text.Length - 1).TrimEnd();
    if (text.EndsWith("...")) text = text.Substring(0, text.Length - 3).TrimEnd();
    return text.ToLowerInvariant();
  }
}

static class SelfTest {
  static int checks;

  static void Check(bool condition, string what) {
    checks++;
    if (!condition) throw new InvalidOperationException("selftest failed: " + what);
  }

  public static int Run() {
    checks = 0;
    Check(Gen.Fnv("abc") == 440920331, "fnv abc");
    Check(Gen.Fnv("") == 18652613, "fnv empty");
    var lines = new List<string>();
    lines.Add(Gen.Line("c1", "AXButton", "Save", "", true, 10, 20, 30, 40));
    lines.Add(Gen.Line("c2", "AXTextField", "Name", "héllo", true, 0, 0, 5, 6));
    Check(string.Join("\n", lines.ToArray()) == "c1|AXButton|Save||10|20|30|40\nc2|AXTextField|Name|héllo|0|0|5|6", "fingerprint text");
    Check(Gen.Of(lines) == 1574858671, "generation vector");
    Check(Gen.Line("c3", "Text", "x", "", true, 1.5, -0.5, 2.4, 2.5).EndsWith("|2|0|2|3"), "rounding");
    var map = Js.Parse("{\"a\":[1,2.5,\"x\\u00e9\\n\",true,null],\"b\":{\"c\":\"d\"}}") as Dictionary<string, object>;
    Check(map != null && map.Count == 2, "json parse");
    Check(Js.Write(map) == "{\"a\":[1,2.5,\"x\\u00e9\\n\",true,null],\"b\":{\"c\":\"d\"}}", "json round trip");
    Check(Js.Write(Js.Parse("{\"s\":\"\\ud83d\\ude00\"}")) == "{\"s\":\"\\ud83d\\ude00\"}", "json surrogates");
    var policy = Js.Parse("{\"exact\":[\"consent.exe\"],\"contains\":[\"1password\",\"proton pass\"]}");
    Rules.Set(policy);
    Check(Rules.Blocked("CONSENT.EXE"), "policy exact");
    Check(Rules.Blocked("1Password.exe"), "policy contains");
    Check(Rules.Blocked("Proton Pass.exe"), "policy contains space");
    Check(!Rules.Blocked("notepad.exe") && !Rules.Blocked(""), "policy allows");
    Rules.Set(null);
    Check(!Rules.Blocked("consent.exe"), "policy reset");
    Check(Rules.NormTitle("&Save As…\tCtrl+S") == "save as", "menu title");
    return checks;
  }
}
// </pure>
