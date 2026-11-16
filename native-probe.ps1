$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Probe {
 [UnmanagedFunctionPointer(CallingConvention.Cdecl)] public delegate void Invalid(IntPtr a,IntPtr b,IntPtr c,uint d,UIntPtr e);
 [DllImport("ucrtbase",CallingConvention=CallingConvention.Cdecl)] public static extern IntPtr _set_invalid_parameter_handler(IntPtr p);
 [DllImport("ucrtbase",CallingConvention=CallingConvention.Cdecl)] public static extern IntPtr _errno();
 [DllImport("ucrtbase",CallingConvention=CallingConvention.Cdecl)] public static extern IntPtr _ltow(int value,IntPtr dst,int radix);
 [DllImport("ucrtbase",CallingConvention=CallingConvention.Cdecl)] public static extern int _ltow_s(int value,IntPtr dst,UIntPtr size,int radix);
 [DllImport("gdi32")] public static extern IntPtr CreateCompatibleDC(IntPtr dc);
 [DllImport("gdi32")] public static extern bool DeleteDC(IntPtr dc);
 [DllImport("gdi32")] public static extern bool GetCharWidth32W(IntPtr dc,uint first,uint last,IntPtr dst);
}
'@
$invalid=[Probe+Invalid]{param($a,$b,$c,$d,$e)}
$old=[Probe]::_set_invalid_parameter_handler([Runtime.InteropServices.Marshal]::GetFunctionPointerForDelegate($invalid))
$mem=[Runtime.InteropServices.Marshal]::AllocHGlobal(256)
$dc=[Probe]::CreateCompatibleDC([IntPtr]::Zero)
$results=@()
try {
 foreach($case in @(@(0,10,64),@(-1,10,64),@(-1,16,64),@([int]::MinValue,10,64),@([int]::MinValue,2,64),@(35,36,64),@(123,10,4),@(123,10,3),@(123,10,1),@(123,10,0),@(123,1,64),@(123,37,64))) {
  for($i=0;$i -lt 128;$i++){[Runtime.InteropServices.Marshal]::WriteInt16($mem,$i*2,0x5555)}
  [Runtime.InteropServices.Marshal]::WriteInt16($mem,200,0)
  [Runtime.InteropServices.Marshal]::WriteInt32([Probe]::_errno(),123)
  $ret=[Probe]::_ltow_s($case[0],$mem,[UIntPtr]$case[2],$case[1])
  $results += [ordered]@{api='_ltow_s';value=$case[0];radix=$case[1];size=$case[2];result=$ret;errno=[Runtime.InteropServices.Marshal]::ReadInt32([Probe]::_errno());text=[Runtime.InteropServices.Marshal]::PtrToStringUni($mem);next=[Runtime.InteropServices.Marshal]::ReadInt16($mem,8)}
 }
 [Runtime.InteropServices.Marshal]::WriteInt32([Probe]::_errno(),123)
 $results += [ordered]@{api='_ltow_s';case='null';result=[Probe]::_ltow_s(1,[IntPtr]::Zero,64,10);errno=[Runtime.InteropServices.Marshal]::ReadInt32([Probe]::_errno())}
 foreach($case in @(@(-1,16),@([int]::MinValue,10),@(35,36))) {
  $ret=[Probe]::_ltow($case[0],$mem,$case[1])
  $results += [ordered]@{api='_ltow';value=$case[0];radix=$case[1];returnedBuffer=($ret -eq $mem);text=[Runtime.InteropServices.Marshal]::PtrToStringUni($mem)}
 }
 foreach($range in @(@(65,67),@(67,65),@(0x10000,0x10000),@(0xffff,0xffff))) {
  $results += [ordered]@{api='GetCharWidth32W';first=$range[0];last=$range[1];result=[Probe]::GetCharWidth32W($dc,$range[0],$range[1],$mem)}
 }
 $results += [ordered]@{api='GetCharWidth32W';case='null DC';result=[Probe]::GetCharWidth32W([IntPtr]::Zero,65,65,$mem)}
 $results += [ordered]@{api='GetCharWidth32W';case='null output';result=[Probe]::GetCharWidth32W($dc,65,65,[IntPtr]::Zero)}
 $results | ConvertTo-Json -Depth 5
} finally {
 [void][Probe]::DeleteDC($dc)
 [void][Probe]::_set_invalid_parameter_handler($old)
 [Runtime.InteropServices.Marshal]::FreeHGlobal($mem)
 [GC]::KeepAlive($invalid)
}
