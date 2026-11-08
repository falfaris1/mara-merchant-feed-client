import { AgentError } from './errors.mjs';
import { FEED_ATTRIBUTES, FEED_UNSUPPORTED_ATTRIBUTES, FEED_LIMITS, FEED_OPERATIONS } from './feed-spec.mjs';
const fail=(code,message)=>{throw new AgentError(code,message);};
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
export const normalizeFeedHeader=value=>value.trim().toLowerCase().replace(/\s+/gu,'_');
export function parseFeedCsv(text,delimiter=','){
  if(typeof text!=='string'||!text.isWellFormed())fail('FEED_INVALID_UNICODE','CSV must be a well-formed Unicode string.');
  if(Buffer.byteLength(text,'utf8')>FEED_LIMITS.maxInputBytes)fail('FEED_BYTE_LIMIT','CSV exceeds1000000 UTF8 bytes.');
  if(![',',';','\t'].includes(delimiter))fail('FEED_DELIMITER','Choose comma, semicolon or tab explicitly.');
  if(text.startsWith('\uFEFF'))text=text.slice(1);
  if(!text)fail('FEED_EMPTY_INPUT','CSV requires a header.');
  if(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\uFFFE\uFFFF]/u.test(text))fail('FEED_CONTROL_CHARACTER','CSV contains characters unsupported by XML1.0.');
  const rows=[];let row=[],field='',mode='start',ended=false;
  const syntax=()=>fail('FEED_CSV_SYNTAX',`Invalid quoting in logical record ${rows.length+1}, column ${row.length+1}.`);
  const endField=()=>{if([...field].length>FEED_LIMITS.maxCellCharacters)fail('FEED_CELL_LIMIT','A cell exceeds16000 Unicode characters.');row.push(field);field='';mode='start';if(row.length>FEED_LIMITS.maxColumns)fail('FEED_COLUMN_LIMIT','CSV exceeds64 columns.');};
  const endRow=()=>{endField();rows.push(row);row=[];ended=true;if(rows.length>FEED_LIMITS.maxDataRecords+1)fail('FEED_RECORD_LIMIT','CSV exceeds1000 data records.');};
  for(let i=0;i<text.length;i++){
    const char=text[i];
    if(mode==='quoted'){ended=false;if(char==='"'){if(text[i+1]==='"'){field+='"';i++;}else mode='after';}else field+=char;}
    else if(char===delimiter){endField();ended=false;}
    else if(char==='\r'||char==='\n'){if(char==='\r'&&text[i+1]==='\n')i++;endRow();}
    else{ended=false;if(mode==='after')syntax();if(char==='"'){if(mode!=='start')syntax();mode='quoted';}else{field+=char;mode='unquoted';}}
    if(field.length>FEED_LIMITS.maxCellCharacters*2)fail('FEED_CELL_LIMIT','A cell exceeds16000 Unicode characters.');
  }
  if(mode==='quoted')syntax();if(!ended)endRow();
  const headers=rows[0],canonical=headers.map(normalizeFeedHeader);
  if(canonical.some(header=>!header))fail('FEED_EMPTY_HEADER','Every header must be nonempty.');
  if(new Set(canonical).size!==canonical.length)fail('FEED_DUPLICATE_HEADER','Headers are ambiguous after casing/space normalization.');
  if(rows.slice(1).some(record=>record.length!==headers.length))fail('FEED_RAGGED_ROW','CSV records must have the same number of columns as the header; values are not invented.');
  return rows;
}
export function validateFeedInput(operationId,input){
  if(!FEED_OPERATIONS.some(operation=>operation.id===operationId))fail('FEED_UNKNOWN_OPERATION','Unknown feed operation.');
  if(!input||typeof input!=='object'||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input))||Reflect.ownKeys(input).some(key=>!['csv','delimiter','mapping','decimalSeparator','currency'].includes(key)))fail('FEED_INVALID_INPUT','Use only csv,delimiter,mapping,decimalSeparator,currency.');
  const delimiter=input.delimiter??',',decimalSeparator=input.decimalSeparator??'.',currency=input.currency??null;
  if(!['.',','].includes(decimalSeparator))fail('FEED_DECIMAL_SEPARATOR','Choose dot or comma explicitly.');
  if(currency!==null&&currency!=='EUR')fail('FEED_CURRENCY_DEFAULT','Only an explicit EUR missing-currency default is supported.');
  const records=parseFeedCsv(input.csv,delimiter),headers=records[0],known=[...FEED_ATTRIBUTES,...FEED_UNSUPPORTED_ATTRIBUTES];
  const mapping={};
  for(const header of headers){const normalized=normalizeFeedHeader(header);if(known.includes(normalized))mapping[normalized]=header;}
  if(input.mapping!==undefined){
    if(!input.mapping||typeof input.mapping!=='object'||Array.isArray(input.mapping)||![Object.prototype,null].includes(Object.getPrototypeOf(input.mapping))||Reflect.ownKeys(input.mapping).some(key=>!known.includes(key)))fail('FEED_MAPPING_ATTRIBUTE','Mapping uses an unsupported attribute.');
    for(const [attribute,column] of Object.entries(input.mapping)){
      if(typeof column!=='string'||column.length===0||[...column].length>16000)fail('FEED_MAPPING_COLUMN','Mapping values must name source headers.');
      const exact=headers.includes(column)?column:headers.find(header=>normalizeFeedHeader(header)===normalizeFeedHeader(column));
      if(exact===undefined)fail('FEED_MAPPING_COLUMN','A mapped source header does not exist.');mapping[attribute]=exact;
    }
  }
  return freeze({csv:input.csv,delimiter,mapping:Object.fromEntries(Object.entries(mapping).sort(([a],[b])=>a<b?-1:a>b?1:0)),decimalSeparator,currency});
}
