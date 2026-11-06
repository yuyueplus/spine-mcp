param([Parameter(Mandatory=$true)][string]$Output)
$ErrorActionPreference='Stop'
$target=[System.IO.Path]::GetFullPath($Output)
[System.IO.Directory]::CreateDirectory($target) | Out-Null
$speaker=New-Object -ComObject SAPI.SpVoice
$choices=@($speaker.GetVoices())
$voice=$choices | Where-Object { $_.GetDescription() -match 'Huihui|Chinese|中文' } | Select-Object -First 1
if (-not $voice) { throw 'A local Chinese SAPI voice is required to build demo callouts' }
$speaker.Voice=$voice
$speaker.Rate=0
$speaker.Volume=95
$digits=@('零','一','二','三','四','五','六','七','八','九')
for($number=1;$number -le 49;$number++){
  if($number -lt 10){$spoken=$digits[$number]}
  elseif($number -eq 10){$spoken='十'}
  elseif($number -lt 20){$spoken='十'+$digits[$number%10]}
  else{$spoken=$digits[[int][Math]::Floor($number/10)]+'十';if($number%10){$spoken+=$digits[$number%10]}}
  foreach($kind in @('normal','special')){
    $file=Join-Path $target ('{0}-{1:00}.wav' -f $kind,$number)
    if(Test-Path -LiteralPath $file){throw "Voice file already exists: $file"}
    $stream=New-Object -ComObject SAPI.SpFileStream
    $format=New-Object -ComObject SAPI.SpAudioFormat
    $format.Type=22
    $stream.Format=$format
    $stream.Open($file,3,$false)
    $speaker.AudioOutputStream=$stream
    $prefix=if($kind -eq 'special'){'特码，'}else{'正码，'}
    [void]$speaker.Speak($prefix+$spoken,0)
    $stream.Close()
    [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($stream)
    [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($format)
  }
}
$description=$speaker.Voice.GetDescription()
[void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($speaker)
@{voice=$description;format='PCM22050mono16';files=98;silentFileGeneration=$true} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $target 'voice-manifest.json') -Encoding utf8
Write-Output ('Generated 98 Chinese number callouts in '+$target)
