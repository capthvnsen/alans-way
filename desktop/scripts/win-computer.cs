// Read and press a Windows desktop through UI Automation. Never moves the pointer.
// Build: csc.exe /nologo /target:exe /r:UIAutomationClient.dll /r:UIAutomationTypes.dll /r:WindowsBase.dll win-computer.cs

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

static class WinComputer {
  const int DepthCap = 12;
  const int ElementCap = 180;
  const int NameCap = 120;
  const int DwmExtendedFrameBounds = 9;
  const int DwmCloaked = 14;
  const int ProcessQueryLimited = 0x1000;
  const int TokenQuery = 0x0008;
  const int TokenElevationClass = 20;
  const uint PrintFullContent = 2;

  [StructLayout(LayoutKind.Sequential)]
  struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

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
  [DllImport("shcore.dll")] static extern int SetProcessDpiAwareness(int awareness);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out RECT rect, int size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, int access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int infoClass, out int info, int size, out int needed);

  static readonly HashSet<ControlType> Interactive = new HashSet<ControlType> {
    ControlType.Button, ControlType.CheckBox, ControlType.ComboBox, ControlType.Edit,
    ControlType.Hyperlink, ControlType.ListItem, ControlType.MenuItem, ControlType.RadioButton,
    ControlType.ScrollBar, ControlType.Slider, ControlType.Spinner, ControlType.SplitButton,
    ControlType.TabItem, ControlType.TreeItem,
  };

  static bool Readable(ControlType type) {
    return Interactive.Contains(type) || type == ControlType.Text;
  }

  class Top {
    public IntPtr Hwnd;
    public int Pid;
    public string Title = "";
    public bool Iconic;
    public RECT Frame;
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
    public string Name = "";
    public double X, Y, Width, Height;
  }

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
      RECT frame;
      if (DwmGetWindowAttribute(hwnd, DwmExtendedFrameBounds, out frame, Marshal.SizeOf(typeof(RECT))) != 0)
        GetWindowRect(hwnd, out frame);
      tops.Add(new Top { Hwnd = hwnd, Pid = (int)pid, Title = TitleOf(hwnd), Iconic = IsIconic(hwnd), Frame = frame });
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

  static readonly Dictionary<int, string> processNames = new Dictionary<int, string>();

  static string ProcessName(int pid) {
    string name;
    if (processNames.TryGetValue(pid, out name)) return name;
    name = "";
    try {
      var process = Process.GetProcessById(pid);
      try { name = Path.GetFileName(process.MainModule.FileName) ?? ""; }
      // MainModule throws for elevated/protected processes — the ones the
      // .exe-suffixed blocklist targets — so keep the same filename shape.
      catch { name = process.ProcessName; if (name.Length > 0 && !name.EndsWith(".exe")) name += ".exe"; }
    } catch { }
    processNames[pid] = name;
    return name;
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

  static void RequireApp(int pid) {
    App found = null;
    foreach (var app in Apps()) if (app.Pid == pid) found = app;
    if (found == null) Fail("App not found.");
    if (Elevated(pid)) Fail("That app is off limits.");
    if (found.Frontmost) Fail("That app is the one in front. Leave it there; the pointer stays where it is.");
    if (ForegroundPid() == 0) Fail("Could not see which window is in front.");
  }

  static List<Found> Collect(int pid) {
    var found = new List<Found>();
    var queue = new Queue<KeyValuePair<AutomationElement, int>>();
    foreach (var top in Tops()) {
      if (top.Pid != pid) continue;
      try {
        var root = AutomationElement.FromHandle(top.Hwnd);
        if (root != null) queue.Enqueue(new KeyValuePair<AutomationElement, int>(root, 0));
      } catch (UnauthorizedAccessException) {
        Fail("That app is off limits.");
      } catch { }
    }
    int visited = 0;
    while (queue.Count > 0 && found.Count < ElementCap && visited++ < 5000) {
      var pair = queue.Dequeue();
      var element = pair.Key;
      int depth = pair.Value;
      ControlType type = null;
      string name = "";
      double x = 0, y = 0, width = 0, height = 0;
      bool offscreen = false, enabled = true;
      try {
        var current = element.Current;
        type = current.ControlType;
        name = current.Name ?? "";
        offscreen = current.IsOffscreen;
        enabled = current.IsEnabled;
        var bounds = current.BoundingRectangle;
        x = bounds.X; y = bounds.Y; width = bounds.Width; height = bounds.Height;
      } catch (UnauthorizedAccessException) {
        Fail("That app is off limits.");
        throw;
      } catch {
        continue;
      }
      if (offscreen) continue;
      if (Readable(type)) {
        object pattern;
        try {
          if ((type == ControlType.Slider || type == ControlType.ScrollBar || type == ControlType.Spinner)
              && element.TryGetCurrentPattern(RangeValuePattern.Pattern, out pattern)) {
            var rounded = ((int)Math.Round(((RangeValuePattern)pattern).Current.Value, MidpointRounding.AwayFromZero)).ToString(CultureInfo.InvariantCulture);
            name = name.Length == 0 ? rounded : name + " " + rounded;
          }
        } catch { }
        try {
          if (element.TryGetCurrentPattern(TogglePattern.Pattern, out pattern))
            name += ((TogglePattern)pattern).Current.ToggleState == ToggleState.On ? " on" : " off";
        } catch { }
        if (!enabled) name += name.Length == 0 ? "disabled" : " disabled";
        found.Add(new Found {
          Element = element, Type = type, X = x, Y = y, Width = width, Height = height,
          Name = name.Length > NameCap ? name.Substring(0, NameCap) : name,
        });
      }
      if (depth >= DepthCap) continue;
      AutomationElement child = null;
      try { child = TreeWalker.ControlViewWalker.GetFirstChild(element); } catch { }
      while (child != null) {
        queue.Enqueue(new KeyValuePair<AutomationElement, int>(child, depth + 1));
        AutomationElement next = null;
        try { next = TreeWalker.ControlViewWalker.GetNextSibling(child); } catch { }
        child = next;
      }
    }
    return found;
  }

  static Found FindRef(int pid, string reference) {
    var list = Collect(pid);
    int index;
    if (reference.Length < 2 || reference[0] != 'c' || !int.TryParse(reference.Substring(1), NumberStyles.Integer, CultureInfo.InvariantCulture, out index)) return null;
    return index >= 1 && index <= list.Count ? list[index - 1] : null;
  }

  static bool IsPassword(AutomationElement element) {
    try { return element.Current.IsPassword; } catch { return false; }
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

  // FromPoint catches controls outside the whitelist; the pid check keeps clicks inside the app.
  static Found HitAtPoint(int pid, double x, double y) {
    var hit = HitAt(Collect(pid), x, y);
    if (hit != null) return hit;
    AutomationElement element = null;
    try { element = AutomationElement.FromPoint(new System.Windows.Point(x, y)); } catch { }
    for (int hops = 0; element != null && hops < 6; hops++) {
      try {
        if (element.Current.ProcessId == pid && Interactive.Contains(element.Current.ControlType)) {
          var bounds = element.Current.BoundingRectangle;
          return new Found {
            Element = element, Type = element.Current.ControlType,
            X = bounds.X, Y = bounds.Y, Width = bounds.Width, Height = bounds.Height,
          };
        }
        element = TreeWalker.ControlViewWalker.GetParent(element);
      } catch {
        return null;
      }
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

  static string Role(ControlType type) {
    const string prefix = "ControlType.";
    var name = type.ProgrammaticName;
    return name.StartsWith(prefix) ? name.Substring(prefix.Length) : name;
  }

  static string Num(double value) {
    if (double.IsNaN(value) || double.IsInfinity(value)) return "0";
    return value.ToString("r", CultureInfo.InvariantCulture);
  }

  static string Json(string value) {
    var json = new StringBuilder(value.Length + 8);
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
    return json.ToString();
  }

  static void Emit(string payload) {
    Emit(payload, 0);
  }

  static void Emit(string payload, int code) {
    Console.Out.Write(payload);
    Console.Out.Write('\n');
    Console.Out.Flush();
    Environment.Exit(code);
  }

  static void Fail(string message) {
    Emit("{\"ok\":false,\"error\":" + Json(message) + "}", 1);
  }

  static int Pid(string[] args, int index, string usage) {
    int pid = 0;
    if (args.Length <= index || !int.TryParse(args[index], NumberStyles.Integer, CultureInfo.InvariantCulture, out pid)) Fail(usage);
    return pid;
  }

  static bool NumArg(string text, out double value) {
    return double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out value);
  }

  static void CommandApps() {
    var apps = Apps();
    var json = new StringBuilder("{\"ok\":true,\"apps\":[");
    for (int i = 0; i < apps.Count; i++) {
      if (i > 0) json.Append(',');
      json.Append("{\"name\":").Append(Json(apps[i].Name))
        .Append(",\"bundleId\":").Append(Json(ProcessName(apps[i].Pid)))
        .Append(",\"pid\":").Append(apps[i].Pid)
        .Append(",\"frontmost\":").Append(apps[i].Frontmost ? "true" : "false").Append('}');
    }
    Emit(json.Append("]}").ToString());
  }

  static void CommandSnapshot(string[] args) {
    int pid = Pid(args, 1, "snapshot needs a pid");
    RequireApp(pid);
    var elements = Collect(pid);
    var json = new StringBuilder("{\"ok\":true,\"elements\":[");
    for (int i = 0; i < elements.Count; i++) {
      if (i > 0) json.Append(',');
      var element = elements[i];
      json.Append("{\"ref\":\"c").Append(i + 1)
        .Append("\",\"role\":").Append(Json(Role(element.Type)))
        .Append(",\"name\":").Append(Json(element.Name))
        .Append(",\"x\":").Append(Num(element.X))
        .Append(",\"y\":").Append(Num(element.Y))
        .Append(",\"width\":").Append(Num(element.Width))
        .Append(",\"height\":").Append(Num(element.Height)).Append('}');
    }
    Emit(json.Append("]}").ToString());
  }

  static void CommandPress(string[] args) {
    int pid = Pid(args, 1, "press needs a pid and a ref");
    if (args.Length < 3) Fail("press needs a pid and a ref");
    RequireApp(pid);
    var found = FindRef(pid, args[2]);
    if (found == null) Fail("Unknown ref. Take a fresh snapshot.");
    if (IsPassword(found.Element)) Fail("Password fields are off limits.");
    if (!Interactive.Contains(found.Type)) Fail("That control has no press action. Take a fresh snapshot.");
    if (!Invoke(found.Element)) Fail("Press failed.");
    Emit("{\"ok\":true,\"cursorMoved\":false}");
  }

  static void CommandClick(string[] args) {
    int pid; double x, y;
    if (args.Length < 4 || !int.TryParse(args[1], out pid) || !NumArg(args[2], out x) || !NumArg(args[3], out y)) Fail("click needs pid x y");
    RequireApp(pid);
    var target = HitAtPoint(pid, x, y);
    if (target == null) Fail("No control at that point. Press a ref instead.");
    if (IsPassword(target.Element)) Fail("Password fields are off limits.");
    if (!Invoke(target.Element)) Fail("Press failed.");
    Emit("{\"ok\":true,\"cursorMoved\":false}");
  }

  static void CommandType(string[] args) {
    int pid = Pid(args, 1, "type needs a pid, a ref, and text");
    if (args.Length < 4) Fail("type needs a pid, a ref, and text");
    RequireApp(pid);
    var found = FindRef(pid, args[2]);
    if (found == null) Fail("Unknown ref. Take a fresh snapshot.");
    if (IsPassword(found.Element)) Fail("Password fields are off limits.");
    if (args[3].Length > 2000) Fail("Text is too long.");
    object pattern;
    ValuePattern value = null;
    try {
      if (found.Element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) value = (ValuePattern)pattern;
    } catch { }
    if (value == null) Fail("That control does not take text.");
    try {
      if (value.Current.IsReadOnly) Fail("That control does not take text.");
      value.SetValue(args[3]);
    } catch {
      Fail("That control does not take text.");
    }
    Emit("{\"ok\":true,\"cursorMoved\":false}");
  }

  static void CommandDrag(string[] args) {
    int pid; double x, y;
    if (args.Length < 4 || !int.TryParse(args[1], out pid) || !NumArg(args[2], out x) || !NumArg(args[3], out y)) Fail("drag needs pid x y");
    if (args.Length < 6) Fail("drag needs x2 y2");
    double x2, y2;
    if (!NumArg(args[4], out x2) || !NumArg(args[5], out y2)) Fail("drag needs x2 y2");
    RequireApp(pid);
    var target = HitAt(Collect(pid), x, y);
    if (target == null) Fail("No control at that point. Press a ref instead.");
    if (IsPassword(target.Element)) Fail("Password fields are off limits.");
    object pattern;
    RangeValuePattern range = null;
    try {
      if (target.Element.TryGetCurrentPattern(RangeValuePattern.Pattern, out pattern)) range = (RangeValuePattern)pattern;
    } catch { }
    if (range == null) Fail("That control cannot be dragged. Press a ref instead.");
    try {
      bool horizontal = target.Width >= target.Height;
      double span = horizontal ? target.Width : target.Height;
      double origin = horizontal ? target.X : target.Y;
      double end = horizontal ? x2 : y2;
      double fraction = span <= 0 ? 0 : Math.Min(1, Math.Max(0, (end - origin) / span));
      range.SetValue(range.Current.Minimum + fraction * (range.Current.Maximum - range.Current.Minimum));
    } catch {
      Fail("That control cannot be dragged. Press a ref instead.");
    }
    Emit("{\"ok\":true,\"cursorMoved\":false}");
  }

  static void CommandShot(string[] args) {
    int pid = Pid(args, 1, "shot needs a pid");
    int cap = 960, requested;
    if (args.Length > 2 && int.TryParse(args[2], out requested)) cap = Math.Min(Math.Max(requested, 320), 1280);
    RequireApp(pid);
    Top best = null;
    foreach (var top in Tops()) {
      if (top.Pid != pid || top.Iconic) continue;
      int width = top.Frame.Right - top.Frame.Left, height = top.Frame.Bottom - top.Frame.Top;
      if (width < 1 || height < 1) continue;
      if (best == null || top.Area > best.Area) best = top;
    }
    if (best == null) Fail("That app has no window to capture.");
    int frameWidth = best.Frame.Right - best.Frame.Left, frameHeight = best.Frame.Bottom - best.Frame.Top;
    Bitmap bitmap = new Bitmap(frameWidth, frameHeight, PixelFormat.Format24bppRgb);
    using (var graphics = Graphics.FromImage(bitmap)) {
      IntPtr hdc = graphics.GetHdc();
      bool drawn = PrintWindow(best.Hwnd, hdc, PrintFullContent) || PrintWindow(best.Hwnd, hdc, 0);
      graphics.ReleaseHdc(hdc);
      if (!drawn) {
        bitmap.Dispose();
        Fail("Could not capture that window.");
      }
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
    quality.Param[0] = new EncoderParameter(Encoder.Quality, 55L);
    var stream = new MemoryStream();
    bitmap.Save(stream, jpeg, quality);
    var image = Convert.ToBase64String(stream.ToArray());
    int imageWidth = bitmap.Width, imageHeight = bitmap.Height;
    bitmap.Dispose();
    Emit("{\"ok\":true,\"image\":\"" + image + "\",\"imageWidth\":" + imageWidth + ",\"imageHeight\":" + imageHeight
      + ",\"windowX\":" + Num(best.Frame.Left) + ",\"windowY\":" + Num(best.Frame.Top)
      + ",\"windowWidth\":" + Num(frameWidth) + ",\"windowHeight\":" + Num(frameHeight) + "}");
  }

  static int Main(string[] args) {
    Thread.CurrentThread.CurrentCulture = CultureInfo.InvariantCulture;
    DpiAware();
    try {
      if (args.Length == 0) Fail("missing command");
      switch (args[0]) {
        case "apps": CommandApps(); break;
        case "snapshot": CommandSnapshot(args); break;
        case "press": CommandPress(args); break;
        case "click": CommandClick(args); break;
        case "type": CommandType(args); break;
        case "drag": CommandDrag(args); break;
        case "shot": CommandShot(args); break;
        default: Fail("unknown command " + args[0]); break;
      }
    } catch (Exception error) {
      Fail(error.Message.Length > 0 ? error.Message : "Desktop helper failed.");
    }
    return 0;
  }
}
