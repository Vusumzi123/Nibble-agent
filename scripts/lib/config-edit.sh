#!/usr/bin/env bash
# Block-scoped YAML scalar editor for the tracked config templates.
#
# The setup script used to rewrite `provider:` / `model:` / `backend:` with a
# first-match-anywhere regex. That silently edited the wrong block once
# `memory:` gained a `provider:` key above `decisions:` (Kael, 2026-10-17).
# Every write here is confined to the named top-level block.
#
# Sourced by scripts/setup.sh; also sourced by scripts/tests. No side effects.

set -euo pipefail

set_block_key() { # set_block_key <file> <block> <key> <value> [anchor-key]
  # <anchor-key>: when <key> is missing, insert it right after this key in the
  # same block (instead of at the block's end) so new keys keep their logical
  # order. Missing file or block is a hard error (exit 2). An existing value is
  # replaced in place, preserving its trailing comment.
  node -e '
const fs=require("fs"),f=process.argv[1],block=process.argv[2],key=process.argv[3],val=process.argv[4],anchor=process.argv[5]||"";
const lines=fs.readFileSync(f,"utf8").split("\n");
const esc=s=>s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
const bRe=new RegExp("^"+esc(block)+":\\s*(#.*)?$");
let bi=-1;
for(let i=0;i<lines.length;i++){ if(bRe.test(lines[i])){ bi=i; break; } }
if(bi<0){ console.error("block not found: "+block); process.exit(2); }
let end=bi+1;
for(; end<lines.length; end++){ const l=lines[end]; if(l.trim()===""||!/^\s/.test(l)) break; }
const kRe=new RegExp("^(\\s+)"+esc(key)+":\\s");
const vRe=new RegExp("^(\\s+"+esc(key)+":\\s+)\\S+");
let found=-1;
for(let i=bi+1;i<end;i++){ if(kRe.test(lines[i])){ found=i; break; } }
if(found>=0){ lines[found]=lines[found].replace(vRe,(m,pre)=>pre+val); }
else {
  let at=end;
  if(anchor){
    const aRe=new RegExp("^(\\s+)"+esc(anchor)+":\\s");
    for(let i=bi+1;i<end;i++){ if(aRe.test(lines[i])){ at=i+1; break; } }
  }
  lines.splice(at,0,"  "+key+": "+val);
}
fs.writeFileSync(f,lines.join("\n"));
' "$1" "$2" "$3" "$4" "${5-}"
}

unset_block_key() { # unset_block_key <file> <block> <key>
  # Remove one key from the named block (no-op when absent). Missing file or
  # block is a hard error (exit 2), matching set_block_key.
  node -e '
const fs=require("fs"),f=process.argv[1],block=process.argv[2],key=process.argv[3];
const lines=fs.readFileSync(f,"utf8").split("\n");
const esc=s=>s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
const bRe=new RegExp("^"+esc(block)+":\\s*(#.*)?$");
let bi=-1;
for(let i=0;i<lines.length;i++){ if(bRe.test(lines[i])){ bi=i; break; } }
if(bi<0){ console.error("block not found: "+block); process.exit(2); }
let end=bi+1;
for(; end<lines.length; end++){ const l=lines[end]; if(l.trim()===""||!/^\s/.test(l)) break; }
const kRe=new RegExp("^\\s+"+esc(key)+":\\s");
for(let i=bi+1;i<end;i++){ if(kRe.test(lines[i])){ lines.splice(i,1); break; } }
fs.writeFileSync(f,lines.join("\n"));
' "$1" "$2" "$3"
}
