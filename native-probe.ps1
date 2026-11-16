$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NativeProbe {
 [UnmanagedFunctionPointer(CallingConvention.Cdecl)] public delegate void Invalid(IntPtr a,IntPtr b,IntPtr c,uint d,UIntPtr e);
 [DllImport("ucrtbase",CallingConvention=CallingConvention.Cdecl)] public static extern IntPtr _set_invalid_parameter_handler(IntPtr p);
 [DllImport("ucrtbase",CallingConvention=CallingConvention.Cdecl)] public static extern IntPtr _errno();
 [DllImport("ucrtbase",CallingConvention=CallingConvention.Cdecl)] public static extern int wcsncpy_s(IntPtr d,UIntPtr n,IntPtr s,UIntPtr c);
 [DllImport("ucrtbase",CallingConvention=CallingConvention.Cdecl)] public static extern int wcsncat_s(IntPtr d,UIntPtr n,IntPtr s,UIntPtr c);
 [DllImport("ucrtbase",CallingConvention=CallingConvention.Cdecl)] public static extern int wcscpy_s(IntPtr d,UIntPtr n,IntPtr s);
 [DllImport("ucrtbase",CallingConvention=CallingConvention.Cdecl)] static extern int __stdio_common_vswprintf_s(ulong options,IntPtr d,UIntPtr n,IntPtr f,IntPtr locale,IntPtr args);
 [DllImport("ucrtbase",CallingConvention=CallingConvention.Cdecl)] static extern int __stdio_common_vsnwprintf_s(ulong options,IntPtr d,UIntPtr n,UIntPtr c,IntPtr f,IntPtr locale,IntPtr args);
 public static int swprintf_s(IntPtr d,UIntPtr n,IntPtr f) {return __stdio_common_vswprintf_s(4,d,n,f,IntPtr.Zero,IntPtr.Zero);}
 public static int _snwprintf_s(IntPtr d,UIntPtr n,UIntPtr c,IntPtr f) {return __stdio_common_vsnwprintf_s(4,d,n,c,f,IntPtr.Zero,IntPtr.Zero);}
 [DllImport("ucrtbase",CallingConvention=CallingConvention.Cdecl)] public static extern IntPtr _wfullpath(IntPtr d,IntPtr s,UIntPtr n);
 [DllImport("ucrtbase",CallingConvention=CallingConvention.Cdecl)] public static extern int _wsplitpath_s(IntPtr p,IntPtr d,UIntPtr dn,IntPtr r,UIntPtr rn,IntPtr f,UIntPtr fn,IntPtr e,UIntPtr en);
 [StructLayout(LayoutKind.Sequential)] public struct Brush { public uint style;public uint color;public UIntPtr hatch; }
 [DllImport("gdi32")] public static extern IntPtr CreateBrushIndirect(ref Brush brush);
 [DllImport("gdi32",EntryPoint="GetObjectW")] public static extern int GetObject(IntPtr h,int n,out Brush brush);
 [DllImport("gdi32")] public static extern bool DeleteObject(IntPtr h);
 [DllImport("gdi32")] public static extern IntPtr GetStockObject(int index);
 [DllImport("gdi32")] public static extern IntPtr CreateBitmap(int width,int height,uint planes,uint bits,IntPtr pixels);
}
'@
$handler = [NativeProbe+Invalid]{param($a,$b,$c,$d,$e)}
$previous = [NativeProbe]::_set_invalid_parameter_handler([Runtime.InteropServices.Marshal]::GetFunctionPointerForDelegate($handler))
$mem = [Runtime.InteropServices.Marshal]::AllocHGlobal(1024)
$source = [Runtime.InteropServices.Marshal]::StringToHGlobalUni('abcdef')
$empty = [Runtime.InteropServices.Marshal]::StringToHGlobalUni('')
$results = @()
function Reset-Buffer {
 for($i=0;$i -lt 128;$i++){[Runtime.InteropServices.Marshal]::WriteInt16($mem,$i*2,0x5555)}
 [Runtime.InteropServices.Marshal]::WriteInt16($mem,0,97)
 [Runtime.InteropServices.Marshal]::WriteInt16($mem,2,0)
 [Runtime.InteropServices.Marshal]::WriteInt32([NativeProbe]::_errno(),123)
}
function Record($name,$value) {
 $script:results += [ordered]@{case=$name;result=$value.ToString();text=[Runtime.InteropServices.Marshal]::PtrToStringUni($mem);errno=[Runtime.InteropServices.Marshal]::ReadInt32([NativeProbe]::_errno());tail=[Runtime.InteropServices.Marshal]::ReadInt16($mem,8)}
}
try {
 Reset-Buffer;Record 'wcsncpy null-zero-zero' ([NativeProbe]::wcsncpy_s([IntPtr]::Zero,0,[IntPtr]::Zero,0))
 Reset-Buffer;Record 'wcsncpy null-source-zero-count' ([NativeProbe]::wcsncpy_s($mem,4,[IntPtr]::Zero,0))
 Reset-Buffer;Record 'wcsncat null-source-zero-count' ([NativeProbe]::wcsncat_s($mem,4,[IntPtr]::Zero,0))
 Reset-Buffer;Record 'wcsncpy truncate' ([NativeProbe]::wcsncpy_s($mem,4,$source,[UIntPtr]::MaxValue))
 Reset-Buffer;Record 'wcscpy overflow' ([NativeProbe]::wcscpy_s($mem,4,$source))
 Reset-Buffer;Record 'snwprintf zero-count' ([NativeProbe]::_snwprintf_s($mem,4,0,$source))
 Reset-Buffer;Record 'snwprintf empty-zero-count' ([NativeProbe]::_snwprintf_s($mem,4,0,$empty))
 Reset-Buffer;Record 'snwprintf null-format' ([NativeProbe]::_snwprintf_s($mem,4,3,[IntPtr]::Zero))
 Reset-Buffer;Record 'swprintf null-format' ([NativeProbe]::swprintf_s($mem,4,[IntPtr]::Zero))
 Reset-Buffer;Record 'snwprintf truncate' ([NativeProbe]::_snwprintf_s($mem,4,[UIntPtr]::MaxValue,$source))
 Reset-Buffer;Record 'snwprintf count-limit' ([NativeProbe]::_snwprintf_s($mem,8,3,$source))
 Reset-Buffer;Record 'wfullpath null-input' ([NativeProbe]::_wfullpath($mem,[IntPtr]::Zero,100))
 Reset-Buffer;Record 'wfullpath short' ([NativeProbe]::_wfullpath($mem,$source,2))
 $hidden = [Runtime.InteropServices.Marshal]::StringToHGlobalUni('.profile')
 Reset-Buffer;Record 'wsplit dotfile' ([NativeProbe]::_wsplitpath_s($hidden,[IntPtr]::Zero,0,[IntPtr]::Zero,0,$mem,32,[IntPtr]::Add($mem,128),32))
 $results += [ordered]@{case='wsplit dotfile extension';text=[Runtime.InteropServices.Marshal]::PtrToStringUni([IntPtr]::Add($mem,128))}
 [Runtime.InteropServices.Marshal]::FreeHGlobal($hidden)
 $b=[NativeProbe+Brush]::new();$b.style=1;$b.color=0x336699
 $one=[NativeProbe]::CreateBrushIndirect([ref]$b);$two=[NativeProbe]::CreateBrushIndirect([ref]$b)
 $out=[NativeProbe+Brush]::new();$written=[NativeProbe]::GetObject($one,16,[ref]$out)
 $results += [ordered]@{case='hollow handles';one=$one.ToInt64();two=$two.ToInt64();written=$written;style=$out.style;color=$out.color;hatch=$out.hatch.ToUInt64()}
 [void][NativeProbe]::DeleteObject($one);[void][NativeProbe]::DeleteObject($two)
 $stock=[NativeProbe]::GetStockObject(5)
 $results += [ordered]@{case='hollow stock identity';matches=($stock -eq $one);survivesDeletion=([NativeProbe]::GetObject($stock,16,[ref]$out) -eq 16)}
 $bitmap=[NativeProbe]::CreateBitmap(2,1,1,32,[IntPtr]::Zero)
 $pattern=[NativeProbe+Brush]::new();$pattern.style=3;$pattern.hatch=[UIntPtr]$bitmap.ToInt64()
 $brush=[NativeProbe]::CreateBrushIndirect([ref]$pattern)
 [void][NativeProbe]::DeleteObject($bitmap)
 $patternOut=[NativeProbe+Brush]::new();$size=[NativeProbe]::GetObject($brush,16,[ref]$patternOut)
 $results += [ordered]@{case='pattern after bitmap deletion';written=$size;style=$patternOut.style;hatch=$patternOut.hatch.ToUInt64();source=$bitmap.ToInt64()}
 [void][NativeProbe]::DeleteObject($brush)
 foreach($path in @('C:/foo/../日本/x','//server/share/dir/../../x','D:../x','/root/../x')) {
  $inputPath=[Runtime.InteropServices.Marshal]::StringToHGlobalUni($path)
  Reset-Buffer;Record ("fullpath " + $path) ([NativeProbe]::_wfullpath($mem,$inputPath,100))
  [Runtime.InteropServices.Marshal]::FreeHGlobal($inputPath)
 }
 $checks=@{
  'wcsncpy null-zero-zero'=@('0','a',123);
  'wcsncpy null-source-zero-count'=@('0','',123);
  'wcsncat null-source-zero-count'=@('0','a',123);
  'wcsncpy truncate'=@('80','abc',123);
  'wcscpy overflow'=@('34','',34);
  'snwprintf zero-count'=@('-1','',123);
  'snwprintf empty-zero-count'=@('0','',123);
  'snwprintf null-format'=@('-1','a',22);
  'swprintf null-format'=@('-1','a',22);
  'snwprintf truncate'=@('-1','abc',123);
  'snwprintf count-limit'=@('-1','abc',123);
  'wfullpath short'=@('0','',34)
 }
 foreach($row in $results) {
  if($checks.ContainsKey($row.case)) {
   $expect=$checks[$row.case]
   if($row.result -ne $expect[0] -or $row.text -ne $expect[1] -or $row.errno -ne $expect[2]) {throw ("native expectation mismatch: " + $row.case)}
  }
 }
 if($stock -ne $one -or $one -ne $two) {throw 'hollow stock identity mismatch'}
 $results | ConvertTo-Json -Depth 5
} finally {
 [NativeProbe]::_set_invalid_parameter_handler($previous) | Out-Null
 [Runtime.InteropServices.Marshal]::FreeHGlobal($source);[Runtime.InteropServices.Marshal]::FreeHGlobal($empty);[Runtime.InteropServices.Marshal]::FreeHGlobal($mem)
 [GC]::KeepAlive($handler)
}
