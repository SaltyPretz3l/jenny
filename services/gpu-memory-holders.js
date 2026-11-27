'use strict';

// Which processes hold GPU memory, for the model-load VRAM check
// (services/backend/vram-load-preflight.js). Called only when a load does not
// fit, so its cost (a PowerShell start, ~2.5 s on Windows) is never paid on a
// load that fits.
//
//   Windows: nvidia-smi reports per-process memory as N/A under WDDM, so the
//            `GPU Process Memory` performance counters are read instead. They
//            are added with PdhAddEnglishCounterW, which takes the English
//            counter name on a Windows of any language (Get-Counter wants the
//            translated name and returned nothing there). Same call as
//            services/performance/gpu-memory-win32.ps1.
//   Linux:   nvidia-smi --query-compute-apps, with /proc for names and parents.
//
// Each holder carries its parent chain so the caller can tell Jenny's own
// engines (and an Ollama daemon's runners) from other programs, and `cards`:
// its memory per card, each with the card's nvidia-smi index: null for a card
// nvidia-smi does not list (an integrated GPU), UNKNOWN_CARD for one whose
// address could not be read (counted on whichever card is asked about).
// `cards` is empty when nvidia-smi listed no card; `mb` is then all there is.
// Never throws: every failure resolves an empty list.

const fs = require('fs');
const { execFile: nodeExecFile } = require('child_process');
const { sanitizeSpawnEnv } = require('./backend/sanitize-spawn-env');

const MIN_HOLDER_MB = 256;
const MAX_CHAIN = 12;
const MAX_CARDS = 16;
const UNKNOWN_CARD = -1;
const HOLDERS_TIMEOUT_MS = 8000;
const CARD_INDEX_ARGS = ['--query-gpu=index,pci.bus_id', '--format=csv,noheader'];

// One PowerShell start: the counter read and the card addresses in compiled C# (PDH and D3DKMT have no cmdlet
// that takes an English counter name), then names and parents from Win32_Process.
const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { '[]'; exit 0 } # no compiled code allowed: names nobody
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
public static class JennyGpuHolders {
    [DllImport("pdh.dll", CharSet=CharSet.Unicode)] static extern uint PdhOpenQuery(string source, IntPtr user, out IntPtr query);
    [DllImport("pdh.dll", CharSet=CharSet.Unicode)] static extern uint PdhAddEnglishCounterW(IntPtr query, string path, IntPtr user, out IntPtr counter);
    [DllImport("pdh.dll")] static extern uint PdhCollectQueryData(IntPtr query);
    [DllImport("pdh.dll", CharSet=CharSet.Unicode)] static extern uint PdhGetFormattedCounterArrayW(IntPtr counter, uint format, ref uint size, out uint count, IntPtr items);
    [DllImport("pdh.dll")] static extern uint PdhCloseQuery(IntPtr query);
    [StructLayout(LayoutKind.Explicit, Size=16)] struct CounterValue { [FieldOffset(0)] public uint Status; [FieldOffset(8)] public long Value; }
    [StructLayout(LayoutKind.Sequential)] struct CounterItem { public IntPtr Name; public CounterValue Data; }
    [StructLayout(LayoutKind.Sequential)] struct Luid { public uint Low; public int High; }
    [StructLayout(LayoutKind.Sequential)] struct OpenAdapter { public Luid Luid; public uint Handle; }
    [StructLayout(LayoutKind.Sequential)] struct QueryInfo { public uint Handle; public int Type; public IntPtr Data; public uint Size; }
    [StructLayout(LayoutKind.Sequential)] struct AdapterAddress { public uint Bus; public uint Device; public uint Function; }
    [DllImport("gdi32.dll")] static extern int D3DKMTOpenAdapterFromLuid(ref OpenAdapter adapter);
    [DllImport("gdi32.dll")] static extern int D3DKMTQueryAdapterInfo(ref QueryInfo query);
    [DllImport("gdi32.dll")] static extern int D3DKMTCloseAdapter(ref uint handle);
    public sealed class Row { public int pid; public string card; public string bus; public long bytes; }
    static string Bus(string high, string low) {
        OpenAdapter adapter = new OpenAdapter { Luid = new Luid { High=unchecked((int)Convert.ToUInt32(high,16)), Low=Convert.ToUInt32(low,16) } };
        if (D3DKMTOpenAdapterFromLuid(ref adapter) != 0) return "";
        IntPtr data = Marshal.AllocHGlobal(12);
        try {
            QueryInfo info = new QueryInfo { Handle=adapter.Handle, Type=6, Data=data, Size=12 }; // KMTQAITYPE_ADAPTERADDRESS
            if (D3DKMTQueryAdapterInfo(ref info) != 0) return "";
            AdapterAddress address = (AdapterAddress)Marshal.PtrToStructure(data, typeof(AdapterAddress));
            if (address.Bus > 255 || address.Device > 31 || address.Function > 7) return "";
            return String.Format("{0:x2}:{1:x2}.{2}", address.Bus, address.Device, address.Function);
        } finally { Marshal.FreeHGlobal(data); D3DKMTCloseAdapter(ref adapter.Handle); }
    }
    public static Row[] Read() {
        List<Row> rows = new List<Row>();
        IntPtr query, counter;
        if (PdhOpenQuery(null, IntPtr.Zero, out query) != 0) return rows.ToArray();
        try {
            if (PdhAddEnglishCounterW(query, @"\\GPU Process Memory(*)\\Dedicated Usage", IntPtr.Zero, out counter) != 0) return rows.ToArray();
            PdhCollectQueryData(query); // absolute byte gauges: the read below says whether there is data
            uint size=0, count;
            PdhGetFormattedCounterArrayW(counter, 0x400, ref size, out count, IntPtr.Zero);
            if (size == 0 || size > 16*1024*1024) return rows.ToArray();
            IntPtr buffer = Marshal.AllocHGlobal((int)size);
            try {
                if (PdhGetFormattedCounterArrayW(counter, 0x400, ref size, out count, buffer) != 0) return rows.ToArray();
                Regex instance = new Regex(@"^pid_(\\d+)_luid_0x([0-9a-fA-F]+)_0x([0-9a-fA-F]+)_phys_(\\d+)");
                Dictionary<string,string> buses = new Dictionary<string,string>();
                int stride = Marshal.SizeOf(typeof(CounterItem));
                for (uint i=0; i<count && i<4096; i++) {
                    CounterItem item = (CounterItem)Marshal.PtrToStructure(IntPtr.Add(buffer, checked((int)i*stride)), typeof(CounterItem));
                    Match match = instance.Match(Marshal.PtrToStringUni(item.Name));
                    if (!match.Success || item.Data.Status > 1 || item.Data.Value <= 0) continue;
                    string card = match.Groups[2].Value.ToLowerInvariant() + "_" + match.Groups[3].Value.ToLowerInvariant() + "_" + match.Groups[4].Value;
                    string bus;
                    // The address query has no physical-index selector: only index 0 of a linked adapter is told apart.
                    if (!buses.TryGetValue(card, out bus)) { bus = match.Groups[4].Value == "0" ? Bus(match.Groups[2].Value, match.Groups[3].Value) : ""; buses[card] = bus; }
                    rows.Add(new Row { pid=Int32.Parse(match.Groups[1].Value), card=card, bus=bus, bytes=item.Data.Value });
                }
            } finally { Marshal.FreeHGlobal(buffer); }
        } finally { PdhCloseQuery(query); }
        return rows.ToArray();
    }
}
'@
$byPid = @{}
$cards = @{}
foreach ($r in [JennyGpuHolders]::Read()) {
  $byPid[$r.pid] = $byPid[$r.pid] + $r.bytes
  if (-not $cards[$r.pid]) { $cards[$r.pid] = @{} }
  $cards[$r.pid][$r.card] = [pscustomobject]@{ bus = $r.bus; bytes = $cards[$r.pid][$r.card].bytes + $r.bytes }
}
$procs = @{}
foreach ($p in Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name -ErrorAction SilentlyContinue) { $procs[[int]$p.ProcessId] = $p }
$out = foreach ($id in $byPid.Keys) {
  if ($byPid[$id] -ge ${MIN_HOLDER_MB * 1024 * 1024}) {
    $chain = @(); $cur = $procs[$id]; $n = 0
    while ($cur -and $n -lt ${MAX_CHAIN}) { $chain += [pscustomobject]@{ pid = [int]$cur.ProcessId; name = [string]$cur.Name }; $cur = $procs[[int]$cur.ParentProcessId]; $n++ }
    $on = @(foreach ($c in $cards[$id].Values) { [pscustomobject]@{ bus = $c.bus; mb = [math]::Round($c.bytes / 1MB) } })
    [pscustomobject]@{ pid = $id; mb = [math]::Round($byPid[$id] / 1MB); chain = $chain; cards = $on }
  }
}
ConvertTo-Json -InputObject @($out) -Compress -Depth 4
`;

function run(execFile, file, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(file, args, {
      timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024, env: sanitizeSpawnEnv(process.env),
    }, (error, stdout) => resolve(error ? '' : String(stdout || '')));
  });
}

function toHolder(raw) {
  const pid = Number(raw?.pid);
  const mb = Number(raw?.mb);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(mb) || mb < MIN_HOLDER_MB) return null;
  const chain = (Array.isArray(raw.chain) ? raw.chain : [])
    .map((link) => ({ pid: Number(link?.pid) || 0, name: String(link?.name || '').slice(0, 120) }))
    .filter((link) => link.pid > 0)
    .slice(0, MAX_CHAIN);
  const name = chain[0]?.pid === pid ? chain[0].name : '';
  const cards = (Array.isArray(raw.cards) ? raw.cards : [])
    .map((card) => ({ bus: busKey(card?.bus), mb: Math.round(Number(card?.mb) || 0) }))
    .filter((card) => card.mb > 0)
    .slice(0, MAX_CARDS);
  return { pid, mb: Math.round(mb), name, chain, cards };
}

// A card's PCI address as both sources agree on it: "bb:dd.f", whatever domain is written in front.
function busKey(text) {
  const found = /([0-9a-f]{2}:[0-9a-f]{2}\.[0-7])\s*$/i.exec(String(text || ''));
  return found ? found[1].toLowerCase() : '';
}

// `nvidia-smi --query-gpu=index,pci.bus_id` rows as address -> index.
function parseCardIndexes(stdout) {
  const indexes = new Map();
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const [indexText, bus] = line.split(',').map((part) => part.trim());
    if (/^\d+$/.test(indexText || '') && busKey(bus)) indexes.set(busKey(bus), Number(indexText));
  }
  return indexes;
}

// Each holder's cards get their nvidia-smi index: null for an address nvidia-smi does not list (another card, such
// as an integrated GPU), UNKNOWN_CARD where the address could not be read. When nvidia-smi listed no card at all
// the cards cannot be told apart and every list is emptied.
function withCardIndexes(holders, indexes) {
  const indexOf = (card) => (!card.bus ? UNKNOWN_CARD : indexes.has(card.bus) ? indexes.get(card.bus) : null);
  return holders.map((holder) => ({ ...holder,
    cards: indexes.size > 0 ? holder.cards.map((card) => ({ index: indexOf(card), mb: card.mb })) : [] }));
}

function parseWindowsHolders(stdout, cardRows = '') {
  try {
    const parsed = JSON.parse(String(stdout || '').trim() || '[]');
    return withCardIndexes((Array.isArray(parsed) ? parsed : [parsed]).map(toHolder).filter(Boolean), parseCardIndexes(cardRows));
  } catch (_error) {
    return [];
  }
}

// `/proc/<pid>/stat`: "pid (comm) state ppid ...". comm may hold spaces or parens.
function readProcStat(pid, fsImpl) {
  try {
    const text = fsImpl.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const open = text.indexOf('(');
    const close = text.lastIndexOf(')');
    if (open < 0 || close < open) return null;
    const ppid = Number(text.slice(close + 2).split(' ')[1]);
    return { name: text.slice(open + 1, close), ppid: Number.isInteger(ppid) ? ppid : 0 };
  } catch (_error) {
    return null;
  }
}

function parseLinuxHolders(stdout, fsImpl, cardRows = '') {
  const byPid = new Map();
  const cardsOf = new Map(); // pid -> address -> MB
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const [pidText, mbText, bus] = line.split(',').map((part) => part.trim());
    const pid = Number(pidText);
    const mb = Number(mbText);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(mb)) continue;
    byPid.set(pid, (byPid.get(pid) || 0) + mb);
    const cards = cardsOf.get(pid) || cardsOf.set(pid, new Map()).get(pid);
    cards.set(busKey(bus), (cards.get(busKey(bus)) || 0) + mb);
  }
  const holders = [];
  for (const [pid, mb] of byPid) {
    const chain = [];
    let current = pid;
    while (current > 0 && chain.length < MAX_CHAIN) {
      const stat = readProcStat(current, fsImpl);
      if (!stat) break;
      chain.push({ pid: current, name: stat.name });
      current = stat.ppid;
    }
    const holder = toHolder({ pid, mb, chain, cards: [...cardsOf.get(pid)].map(([bus, onCard]) => ({ bus, mb: onCard })) });
    if (holder) holders.push(holder);
  }
  return withCardIndexes(holders, parseCardIndexes(cardRows));
}

// A holder's memory on the card a model is loading on (the probe's device row): its share there, plus what sits
// on a card of unknown address, when the cards were told apart and the device has an index; else all of it.
function holderMbOnCard(holder, device) {
  const cards = Array.isArray(holder?.cards) ? holder.cards : [];
  if (cards.length === 0 || !Number.isInteger(device?.index)) return Number(holder?.mb) || 0;
  return cards.filter((card) => card.index === device.index || card.index === UNKNOWN_CARD).reduce((sum, card) => sum + card.mb, 0);
}

async function listGpuMemoryHolders({
  platform = process.platform,
  execFile = nodeExecFile,
  fsImpl = fs,
  timeoutMs = HOLDERS_TIMEOUT_MS,
} = {}) {
  try {
    if (platform === 'win32') {
      const encoded = Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64');
      const [stdout, cardRows] = await Promise.all([
        run(execFile, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], timeoutMs),
        run(execFile, 'nvidia-smi', CARD_INDEX_ARGS, timeoutMs),
      ]);
      return parseWindowsHolders(stdout, cardRows);
    }
    if (platform === 'linux') {
      const [stdout, cardRows] = await Promise.all([
        run(execFile, 'nvidia-smi', ['--query-compute-apps=pid,used_memory,gpu_bus_id', '--format=csv,noheader,nounits'], timeoutMs),
        run(execFile, 'nvidia-smi', CARD_INDEX_ARGS, timeoutMs),
      ]);
      return parseLinuxHolders(stdout, fsImpl, cardRows);
    }
  } catch (_error) { /* an unanswered lookup names nobody */ }
  return [];
}

module.exports = {
  MIN_HOLDER_MB,
  holderMbOnCard,
  listGpuMemoryHolders,
  parseLinuxHolders,
  parseWindowsHolders,
};
