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
 [DllImport("ucrtbase",CallingConvention=CallingConvention.Cdecl)] public static extern int swprintf_s(IntPtr d,UIntPtr n,IntPtr f);
 [DllImport("ucrtbase",CallingConvention=CallingConvention.Cdecl)] public static extern int _snwprintf_s(IntPtr d,UIntPtr n,UIntPtr c,IntPtr f);
 [DllImport("ucrtbase",CallingConvention=CallingConvention.Cdecl)] public static extern IntPtr _wfullpath(IntPtr d,IntPtr s,UIntPtr n);
 [DllImport("ucrtbase",CallingConvention=CallingConvention.Cdecl)] public static extern int _wsplitpath_s(IntPtr p,IntPtr d,UIntPtr dn,IntPtr r,UIntPtr rn,IntPtr f,UIntPtr fn,IntPtr e,UIntPtr en);
 [StructLayout(LayoutKind.Sequential)] public struct Brush { public uint style;public uint color;public UIntPtr hatch; }
 [DllImport("gdi32")] public static extern IntPtr CreateBrushIndirect(ref Brush brush);
 [DllImport("gdi32",EntryPoint="GetObjectW")] public static extern int GetObject(IntPtr h,int n,out Brush brush);
 [DllImport("gdi32")] public static extern bool DeleteObject(IntPtr h);
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
 Reset-Buffer;Record 'wcsncpy truncate' ([NativeProbe]::wcsncpy_s($mem,4,$source,[UIntPtr]0xffffffff))
 Reset-Buffer;Record 'wcscpy overflow' ([NativeProbe]::wcscpy_s($mem,4,$source))
 Reset-Buffer;Record 'snwprintf zero-count' ([NativeProbe]::_snwprintf_s($mem,4,0,$source))
 Reset-Buffer;Record 'snwprintf empty-zero-count' ([NativeProbe]::_snwprintf_s($mem,4,0,$empty))
 Reset-Buffer;Record 'snwprintf null-format' ([NativeProbe]::_snwprintf_s($mem,4,3,[IntPtr]::Zero))
 Reset-Buffer;Record 'swprintf null-format' ([NativeProbe]::swprintf_s($mem,4,[IntPtr]::Zero))
 Reset-Buffer;Record 'snwprintf truncate' ([NativeProbe]::_snwprintf_s($mem,4,[UIntPtr]0xffffffff,$source))
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
 $results | ConvertTo-Json -Depth 5
} finally {
 [NativeProbe]::_set_invalid_parameter_handler($previous) | Out-Null
 [Runtime.InteropServices.Marshal]::FreeHGlobal($source);[Runtime.InteropServices.Marshal]::FreeHGlobal($empty);[Runtime.InteropServices.Marshal]::FreeHGlobal($mem)
 [GC]::KeepAlive($handler)
}
