import { AgentError } from './errors.mjs';
import { FEED_OPERATIONS } from './feed-spec.mjs';
import { validateFeedInput } from './feed-input.mjs';

const quantitySchema={type:'integer',minimum:1,maximum:1000,default:1};
const skuSchema={type:'string',minLength:1,maxLength:80,pattern:'^[\\p{L}\\p{N}][\\p{L}\\p{N}_.-]{0,79}$'};
function freeze(value){if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
const text = maximum => ({type:'string',minLength:1,maxLength:maximum});
const time = {type:['string','null'],format:'date-time',maxLength:40};
const money = {type:'string',pattern:'^[0-9]{1,16}\\.[0-9]{2}$',maxLength:19};
const objectSchema = properties => ({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
const commonOutput = {
  provider:{const:'Modula24'},sourceUrl:{type:'string',format:'uri',maxLength:2048},
  attribution:objectSchema({name:{const:'Modula24'},url:{const:'https://modula24.com/pages/api'}}),
  retrievedAt:{type:'string',format:'date-time',maxLength:40},sourceDataUpdatedAt:time,
  cacheAgeSeconds:{type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER},
  warnings:{type:'array',maxItems:20,uniqueItems:true,items:text(120)},currency:{const:'EUR'},
  vatBasis:{const:'not_specified_by_source'},shippingExcluded:{const:true},orderNotPlaced:{const:true},
};
export const PARTS_QUOTE_OUTPUT_SCHEMA=freeze(objectSchema({...commonOutput,
  sku:text(80),title:text(500),shopUrl:{type:'string',format:'uri',maxLength:2048},unitPrice:money,
  quantity:{type:'integer',minimum:1,maximum:1000},lineTotal:money,
  availableQuantity:{type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER},
  requestedQuantityFulfillable:{type:'boolean'},itemUpdatedAt:time,
}));
export const PARTS_BASKET_OUTPUT_SCHEMA=freeze(objectSchema({...commonOutput,
  items:{type:'array',minItems:1,maxItems:20,items:PARTS_QUOTE_OUTPUT_SCHEMA},totalPrice:money,allRequestedQuantitiesFulfillable:{type:'boolean'},
}));
export const PARTS_SEARCH_OUTPUT_SCHEMA=freeze(objectSchema({...commonOutput,
  query:text(80),quantity:{type:'integer',minimum:1,maximum:1000},count:{type:'integer',minimum:1,maximum:20},
  items:{type:'array',minItems:1,maxItems:20,items:PARTS_QUOTE_OUTPUT_SCHEMA},
}));
export const PARTS_OPERATIONS=freeze([
  {id:'parts_quote',name:'MaraPartsQuote',version:1,path:'/v1/parts/quote',amountAtomic:'30000',description:'One source-backed Modula24 compatible-part price and availability quote for an explicit SKU and quantity.',inputSchema:{type:'object',required:['sku'],additionalProperties:false,properties:{sku:skuSchema,quantity:quantitySchema}},example:{sku:'kugel',quantity:1}},
  {id:'parts_basket',name:'MaraPartsBasket',version:1,path:'/v1/parts/basket',amountAtomic:'50000',description:'A source-backed basket calculation for up to 20 unique Modula24 compatible-part SKUs with explicit quantities.',inputSchema:{type:'object',required:['items'],additionalProperties:false,properties:{items:{type:'array',minItems:1,maxItems:20,items:{type:'object',required:['sku'],additionalProperties:false,properties:{sku:skuSchema,quantity:quantitySchema}}}}},example:{items:[{sku:'kugel',quantity:1}]}},
  {id:'parts_search',name:'MaraPartsSearch',version:1,path:'/v1/parts/search',amountAtomic:'30000',description:'Search the supported Modula24 compatible-part catalog and return up to 20 source-backed price and availability results.',inputSchema:{type:'object',required:['query'],additionalProperties:false,properties:{query:{type:'string',minLength:1,maxLength:80},quantity:quantitySchema,limit:{type:'integer',minimum:1,maximum:20,default:10}}},example:{query:'kugel',quantity:1,limit:10}},
].map(operation=>({...operation,outputSchema:({parts_quote:PARTS_QUOTE_OUTPUT_SCHEMA,parts_basket:PARTS_BASKET_OUTPUT_SCHEMA,parts_search:PARTS_SEARCH_OUTPUT_SCHEMA})[operation.id]})));
export const getPartOperation=id=>PARTS_OPERATIONS.find(operation=>operation.id===id)??null;
export const SERVICE_OPERATIONS=freeze([...PARTS_OPERATIONS,...FEED_OPERATIONS]);
export const getOperation=id=>SERVICE_OPERATIONS.find(operation=>operation.id===id)??null;
export function operationConfig(config,operation){
  const registered=getOperation(typeof operation==='string'?operation:operation?.id);
  if(!registered)throw new TypeError('Unknown service operation');
  return Object.freeze({...config,resourceUrl:config.publicBaseUrl+registered.path,amountAtomic:registered.amountAtomic,operationId:registered.id,operationVersion:registered.version,serviceName:registered.name,serviceDescription:registered.description});
}
const fail=()=>{throw new AgentError('INVALID_PARTS_INPUT','Provide the documented bounded parts input; quantities must be integers from 1 to 1000.');};
function object(value,keys,required){
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value))||Object.keys(value).some(key=>!keys.includes(key))||required.some(key=>!Object.hasOwn(value,key)))fail();
}
function quantity(value){const result=value===undefined?1:value;if(!Number.isSafeInteger(result)||result<1||result>1000)fail();return result;}
function sku(value){if(typeof value!=='string')fail();const result=value.trim().normalize('NFC').toLowerCase();if(!/^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,79}$/u.test(result))fail();return result;}
export function validatePartsInput(operationId,input){
  if(!getPartOperation(operationId))fail();
  let result;
  if(operationId==='parts_quote'){object(input,['sku','quantity'],['sku']);result={sku:sku(input.sku),quantity:quantity(input.quantity)};}
  else if(operationId==='parts_basket'){
    object(input,['items'],['items']);if(!Array.isArray(input.items)||input.items.length<1||input.items.length>20)fail();
    const items=input.items.map(item=>{object(item,['sku','quantity'],['sku']);return {sku:sku(item.sku),quantity:quantity(item.quantity)};});
    if(new Set(items.map(item=>item.sku)).size!==items.length)fail();result={items};
  }else{
    object(input,['query','quantity','limit'],['query']);if(typeof input.query!=='string'||!input.query.isWellFormed()||/[\p{Cc}\p{Cf}\p{Cs}]/u.test(input.query)||input.query.length>100)fail();
    const query=input.query.normalize('NFC').trim(),limit=input.limit===undefined?10:input.limit;
    if(query.length<1||query.length>80||!Number.isSafeInteger(limit)||limit<1||limit>20)fail();result={query,quantity:quantity(input.quantity),limit};
  }
  return freeze(result);
}
export function validateOperationInput(operationId,input){
  if(getPartOperation(operationId))return validatePartsInput(operationId,input);
  if(FEED_OPERATIONS.some(operation=>operation.id===operationId))return validateFeedInput(operationId,input);
  throw new AgentError('INVALID_OPERATION','Select a documented service operation.');
}
