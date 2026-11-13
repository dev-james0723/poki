import {z} from 'zod';

const label=z.string().trim().min(1).max(200);
const selector=z.object({
  labels:z.array(label).min(1).max(80).optional(),
  roles:z.array(label).min(1).max(20).optional(),
  object_ids:z.array(label).min(1).max(80).optional(),
}).strict().refine(q=>q.labels||q.roles||q.object_ids,'Specify labels, roles or object_ids');
const bounds=z.object({
  x:z.number().finite().min(0).max(16384),
  y:z.number().finite().min(0).max(16384),
  width:z.number().finite().positive().max(16384),
  height:z.number().finite().positive().max(16384),
}).strict();
const queryCondition=z.discriminatedUnion('state',[
  z.object({state:z.literal('present'),query:selector}).strict(),
  z.object({state:z.literal('absent'),query:selector}).strict(),
  z.object({state:z.literal('unique'),query:selector}).strict(),
  z.object({state:z.literal('field_equals'),query:selector,field:z.enum(['value','text']),equals:z.string().max(10000)}).strict(),
  z.object({state:z.literal('bounds_match'),query:selector,expected_bounds:bounds,tolerance:z.number().finite().min(0).max(10).default(0)}).strict(),
]);
const base={
  device:label.optional(),
  expected_app:label.describe('Exact foreground application bundle identifier'),
  condition:queryCondition,
  timeout_ms:z.number().int().min(100).max(30000).default(6000),
};
export const uiQuerySchema=z.object(base).strict();
export const uiWaitSchema=z.object({
  ...base,timeout_ms:base.timeout_ms.default(10000),
  poll_ms:z.number().int().min(100).max(1000).default(250),
}).strict();

export const uiQueryDefinitions=[
  ['query_ui','Check one condition against a fresh native AX read and return matching visible elements. The native request still collects a complete tree; actual coverage is reported separately. Absence and label-based uniqueness require verified complete coverage. Observed presence and one exact object_id can prove their own value/bounds without claiming global coverage. No screenshots/OCR or input cache. Field equality never proves save/send.',uiQuerySchema,true],
  ['wait_for_ui','Wait within a bounded deadline using fresh native AX reads with complete-tree collection. A final receipt requires the expected app, root geometry, current epoch and no privacy prompt. Absence/general uniqueness additionally require complete coverage; exact object proofs report their narrower scope. Stops on app/epoch changes, source failure or cancellation. No screenshots/OCR or input cache.',uiWaitSchema,true],
];
