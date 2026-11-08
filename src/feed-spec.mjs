import { createHash } from 'node:crypto';
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
export const FEED_LIMITS=freeze({maxInputBytes:1000000,maxDataRecords:1000,maxColumns:64,maxCellCharacters:16000,maxIssues:500,maxChanges:500,maxReportBytes:2000000,maxHttpBodyBytes:2200000});
export const FEED_RULES_VERSION='google-merchant-core-2026-11-08.1';
export const FEED_SOURCE='https://support.google.com/merchants/answer/7052112?hl=en';
export const FEED_ATTRIBUTES=freeze(['id','title','description','link','image_link','additional_image_link','price','sale_price','availability','availability_date','brand','gtin','mpn','condition','item_group_id','color','size','gender','age_group','material','pattern','google_product_category','product_type','identifier_exists','adult','is_bundle','multipack','custom_label_0','custom_label_1','custom_label_2','custom_label_3','custom_label_4']);
export const FEED_UNSUPPORTED_ATTRIBUTES=freeze(['structured_title','structured_description']);
export const FEED_INPUT_SCHEMA=freeze({type:'object',required:['csv'],additionalProperties:false,properties:{
  csv:{type:'string',minLength:1,maxLength:1000000,description:'At most1000000 UTF8 bytes,1000 logical data records,64 columns and16000 Unicode characters per cell. RFC4180 quotes; no encoding or delimiter guessing.'},
  delimiter:{enum:[',',';','\t'],default:','},decimalSeparator:{enum:['.',','],default:'.'},currency:{enum:[null,'EUR'],default:null,description:'Explicit EUR default only for a price missing a suffix. No currency conversion.'},
  mapping:{type:'object',maxProperties:34,propertyNames:{enum:[...FEED_ATTRIBUTES,...FEED_UNSUPPORTED_ATTRIBUTES]},additionalProperties:{type:'string',minLength:1,maxLength:16000},description:'Google attribute to exact source header. Standard headers are recognized after casing/outer-space normalization. Ambiguous mappings fail.'},
}});
const string=maximum=>({type:'string',maxLength:maximum});
const integer=maximum=>({type:'integer',minimum:0,maximum});
const object=properties=>({type:'object',required:Object.keys(properties),additionalProperties:false,properties});
const preview=object({preview:string(100),characters:integer(16020),sha256:{type:'string',pattern:'^[0-9a-f]{64}$'},truncated:{type:'boolean'}});
const common={
  service:{enum:['MaraFeedAudit','MaraFeedPrepare']},version:{const:1},rulesVersion:{const:FEED_RULES_VERSION},source:{const:FEED_SOURCE},
  inputSha256:{type:'string',pattern:'^[0-9a-f]{64}$'},
  counts:object({rows:integer(1000),columns:integer(64),errors:integer(100000),warnings:integer(100000),infos:integer(100000)}),
  issues:{type:'array',maxItems:500,items:object({severity:{enum:['error','warning','info']},code:string(80),row:integer(1001),field:string(80),sourceColumn:{type:['string','null'],maxLength:128},message:string(500),reference:{type:'string',maxLength:2048}})},
  issueCount:integer(100000),issuesTruncated:{type:'boolean'},mapping:{type:'object',maxProperties:34,additionalProperties:string(16000)},
  unmappedColumns:{type:'array',maxItems:64,items:string(16000)},validWithinScope:{type:'boolean'},googleApprovalGuaranteed:{const:false},externalUrlsFetched:{const:false},googleSubmissionPerformed:{const:false},
  coveredRules:{type:'array',maxItems:30,items:string(160)},limitations:{type:'array',maxItems:20,items:string(500)},
};
export const FEED_AUDIT_OUTPUT_SCHEMA=freeze(object({...common,service:{const:'MaraFeedAudit'}}));
export const FEED_PREPARE_OUTPUT_SCHEMA=freeze(object({...common,service:{const:'MaraFeedPrepare'},
  changes:{type:'array',maxItems:500,items:object({row:integer(1001),field:string(80),code:string(80),before:preview,after:preview})},changeCount:integer(100000),changesTruncated:{type:'boolean'},
  artifact:object({format:{const:'google-merchant-rss-xml'},fileName:{const:'merchant-feed.xml'},status:{enum:['draft','ready_within_scope']},sha256:{type:'string',pattern:'^[0-9a-f]{64}$'},bytes:integer(2000000),xml:string(2000000)}),
}));
const example={csv:'id,title,description,link,image_link,price,availability,brand,gtin\n0001,Sample product,Non-personal synthetic catalog,https://example.com/item,https://example.com/image.jpg,12.34 EUR,in_stock,Example,4006381333931\n'};
const exampleXml='<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel><title>Synthetic feed example</title><link>https://example.com/item</link><description>Schema example; no Google approval</description><item><g:id>0001</g:id><g:title>Sample product</g:title><g:description>Non-personal synthetic catalog</g:description><g:link>https://example.com/item</g:link><g:image_link>https://example.com/image.jpg</g:image_link><g:price>12.34 EUR</g:price><g:availability>in_stock</g:availability><g:brand>Example</g:brand><g:gtin>4006381333931</g:gtin></item></channel></rss>\n';
const baseExample={service:'MaraFeedAudit',version:1,rulesVersion:FEED_RULES_VERSION,source:FEED_SOURCE,inputSha256:createHash('sha256').update(example.csv).digest('hex'),counts:{rows:1,columns:9,errors:0,warnings:0,infos:0},issues:[],issueCount:0,issuesTruncated:false,mapping:{id:'id',title:'title',description:'description',link:'link',image_link:'image_link',price:'price',availability:'availability',brand:'brand',gtin:'gtin'},unmappedColumns:[],validWithinScope:true,googleApprovalGuaranteed:false,externalUrlsFetched:false,googleSubmissionPerformed:false,coveredRules:['Synthetic schema example; no real Google submission'],limitations:['Synthetic example, not a Google approval or a current customer feed.']};
export const FEED_OPERATIONS=freeze([
  {id:'feed_audit',name:'MaraFeedAudit',version:1,path:'/v1/feeds/audit',amountAtomic:'500000',description:'Bounded product-catalog CSV preflight with explicit mapping, exact diagnostics and no Google approval guarantee.',inputSchema:FEED_INPUT_SCHEMA,outputSchema:FEED_AUDIT_OUTPUT_SCHEMA,example,outputExample:baseExample},
  {id:'feed_prepare',name:'MaraFeedPrepare',version:1,path:'/v1/feeds/prepare',amountAtomic:'2000000',description:'Deterministic fact-preserving Google-format RSS/XML preparation, bounded change log and explicit draft status if errors remain.',inputSchema:FEED_INPUT_SCHEMA,outputSchema:FEED_PREPARE_OUTPUT_SCHEMA,example,outputExample:{...baseExample,service:'MaraFeedPrepare',changes:[],changeCount:0,changesTruncated:false,artifact:{format:'google-merchant-rss-xml',fileName:'merchant-feed.xml',status:'ready_within_scope',sha256:createHash('sha256').update(exampleXml).digest('hex'),bytes:Buffer.byteLength(exampleXml,'utf8'),xml:exampleXml}}},
]);
