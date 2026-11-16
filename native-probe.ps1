$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Probe {
 [UnmanagedFunctionPointer(CallingConvention.Cdecl)] public delegate void Invalid(IntPtr a,IntPtr b,IntPtr c,uint d,UIntPtr e);
 [DllImport("ucrtbase",CallingConvention=CallingConvention.Cdecl)] public static extern IntPtr _set_invalid_parameter_handler(IntPtr p);
 [DllImport("ucrtbase",CallingConvention=CallingConvention.Cdecl)] public static extern IntPtr _errno();
 [DllImport("ucrtbase",CallingConvention=CallingConvention.Cdecl)] public static extern IntPtr _wfullpath(IntPtr dst,IntPtr src,UIntPtr size);
 [DllImport("ucrtbase",CallingConvention=CallingConvention.Cdecl)] public static extern int wcsncat_s(IntPtr d,UIntPtr n,IntPtr s,UIntPtr c);
 [DllImport("ucrtbase",CallingConvention=CallingConvention.Cdecl)] public static extern int __stdio_common_vswprintf_s(ulong o,IntPtr d,UIntPtr n,IntPtr f,IntPtr l,IntPtr a);
 [DllImport("ucrtbase",CallingConvention=CallingConvention.Cdecl)] public static extern int __stdio_common_vsnwprintf_s(ulong o,IntPtr d,UIntPtr n,UIntPtr c,IntPtr f,IntPtr l,IntPtr a);
}
'@
$invalid=[Probe+Invalid]{param($a,$b,$c,$d,$e)}
$old=[Probe]::_set_invalid_parameter_handler([Runtime.InteropServices.Marshal]::GetFunctionPointerForDelegate($invalid))
$mem=[Runtime.InteropServices.Marshal]::AllocHGlobal(2048)
$canary=[Runtime.InteropServices.Marshal]::AllocHGlobal(16)
$argsBlock=[Runtime.InteropServices.Marshal]::AllocHGlobal(16)
[Runtime.InteropServices.Marshal]::WriteIntPtr($argsBlock,$canary)
$results=@()
function Reset-Buffer {
 for($i=0;$i -lt 1024;$i++){[Runtime.InteropServices.Marshal]::WriteInt16($mem,$i*2,0x5555)}
 [Runtime.InteropServices.Marshal]::WriteInt16($mem,0,120)
 [Runtime.InteropServices.Marshal]::WriteInt16($mem,2,0)
 [Runtime.InteropServices.Marshal]::WriteInt32($canary,0x12345678)
 [Runtime.InteropServices.Marshal]::WriteInt32([Probe]::_errno(),123)
}
try {
 foreach($path in @('C:\folder\','\\server\share\folder\','C:\folder\file.  ','C:\foo   ','C:\foo.\bar','C:\foo \bar','C:\foo.\','C:\foo \','C:\foo\..','C:\foo\.','C:\foo\..\','\\?\C:\folder\file.  ','\\?\C:\folder\..\x','\\?\UNC\server\share\folder\..\x','\\.\C:\folder\file.  ','\\?\C:/folder/file.  ')) {
  $inputPath=[Runtime.InteropServices.Marshal]::StringToHGlobalUni($path)
  Reset-Buffer
  $ret=[Probe]::_wfullpath($mem,$inputPath,1000)
  $results += [ordered]@{api='_wfullpath';input=$path;success=($ret -eq $mem);text=[Runtime.InteropServices.Marshal]::PtrToStringUni($mem);errno=[Runtime.InteropServices.Marshal]::ReadInt32([Probe]::_errno())}
  if($path -eq 'C:\folder\') {
   Reset-Buffer
   $ret=[Probe]::_wfullpath($mem,$inputPath,10)
   $results += [ordered]@{api='_wfullpath';input=$path;size=10;success=($ret -eq $mem);text=[Runtime.InteropServices.Marshal]::PtrToStringUni($mem);errno=[Runtime.InteropServices.Marshal]::ReadInt32([Probe]::_errno())}
  }
  [Runtime.InteropServices.Marshal]::FreeHGlobal($inputPath)
 }
 Reset-Buffer
 $ret=[Probe]::wcsncat_s([IntPtr]::Zero,0,[IntPtr]::Zero,0)
 $results += [ordered]@{api='wcsncat_s';case='null-zero';result=$ret;errno=[Runtime.InteropServices.Marshal]::ReadInt32([Probe]::_errno())}
 foreach($fmt in @('%q','%','x%n','%hn','%I64n','%%n','%I32')) {
  $f=[Runtime.InteropServices.Marshal]::StringToHGlobalUni($fmt)
  foreach($counted in @($false,$true)) {
   Reset-Buffer
   if($counted) {$ret=[Probe]::__stdio_common_vsnwprintf_s(4,$mem,64,63,$f,[IntPtr]::Zero,$argsBlock)}
   else {$ret=[Probe]::__stdio_common_vswprintf_s(4,$mem,64,$f,[IntPtr]::Zero,$argsBlock)}
   $results += [ordered]@{api= $(if($counted){'_snwprintf_s'}else{'swprintf_s'});format=$fmt;result=$ret;text=[Runtime.InteropServices.Marshal]::PtrToStringUni($mem);errno=[Runtime.InteropServices.Marshal]::ReadInt32([Probe]::_errno());canary=[Runtime.InteropServices.Marshal]::ReadInt32($canary)}
  }
  [Runtime.InteropServices.Marshal]::FreeHGlobal($f)
 }
 $results | ConvertTo-Json -Depth 5
} finally {
 [void][Probe]::_set_invalid_parameter_handler($old)
 [Runtime.InteropServices.Marshal]::FreeHGlobal($mem)
 [Runtime.InteropServices.Marshal]::FreeHGlobal($canary)
 [Runtime.InteropServices.Marshal]::FreeHGlobal($argsBlock)
 [GC]::KeepAlive($invalid)
}
