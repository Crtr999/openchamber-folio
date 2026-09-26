import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockToDocument, documentToText } from './rich-text';
import { makeBlock, type FolioBlock } from './schema';

test('formatting survives Unicode, overlapping marks, and line breaks',()=>{
 const block={...makeBlock(),text:'Hi 👋 reader\nTwo',marks:[{start:3,length:2,style:'bold' as const},{start:3,length:9,style:'highlight' as const,value:'yellow'},{start:6,length:6,style:'link' as const,value:'https://example.com'}]};
 const roundtrip=documentToText(blockToDocument(block));
 assert.equal(roundtrip.text,block.text);
 const stylesAt=(marks:NonNullable<FolioBlock['marks']>,position:number)=>marks.filter(m=>m.start<=position && m.start+m.length>position).map(m=>[m.style,m.value]).sort();
 for(let position=0;position<block.text.length;position++)if(block.text[position]!=='\n')assert.deepEqual(stylesAt(roundtrip.marks || [],position),stylesAt(block.marks,position));
});
test('plain empty blocks stay editable and preserve empty lines',()=>{
 for(const text of ['', '\n', 'one\n\ntwo'])assert.equal(documentToText(blockToDocument({...makeBlock(),text})).text,text);
});

test('legacy Folio formatting renders while explicit plain text and code remain literal',()=>{
 const legacy={...makeBlock(),text:'A **bold** ==bright== [link](https://example.com)',marks:undefined};
 const result=documentToText(blockToDocument(legacy));
 assert.equal(result.text,'A bold bright link');
 assert.deepEqual(result.marks?.map(m=>m.style),['bold','highlight','link']);
 assert.equal(documentToText(blockToDocument({...legacy,marks:[]})).text,legacy.text);
 assert.equal(documentToText(blockToDocument({...legacy,kind:'code'})).text,legacy.text);
});
