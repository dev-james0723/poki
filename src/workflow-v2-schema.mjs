import {z} from 'zod';

const label=z.string().trim().min(1).max(200);
const device={device:label.optional()};
export const stateGuard=z.object({all:z.array(label).max(20).default([]),any:z.array(label).max(20).default([]),none:z.array(label).max(20).default([])})
  .strict().refine(g=>g.all.length+g.any.length>0,'A positive result condition is required');
const conditional={expected_app:label.optional(),when:stateGuard.optional(),expect:stateGuard.optional()};
export const appActionSchema=z.object({...device,shortcut:label,input:z.string().max(10000).optional(),expected_app:label,expect:stateGuard}).strict();
export const sequenceSchema=z.object({...device,expected_app:label,labels:z.array(label).min(2).max(8),fixed_layout:z.literal(true),interval_ms:z.number().int().min(30).max(250).default(50)}).strict();
const modelSessionSchema=z.object({apps:z.array(label).min(1).max(12).refine(a=>new Set(a).size===a.length,'App scope must be unique'),max_calls:z.number().int().min(1).max(120),ttl_seconds:z.number().int().min(60).max(3600),purpose:z.string().trim().min(1).max(300)}).strict();
export const choiceSchema=z.object({...device,expected_app:label,goal:z.string().trim().min(1).max(600),labels:z.array(label).min(2).max(6).refine(a=>new Set(a).size===a.length,'Choice labels must be unique'),exact_label:label.optional(),use_model:z.boolean().default(false),use_session:z.boolean().default(false),model_session:modelSessionSchema.optional()}).strict();
const steps=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('tap'),label,...conditional}).strict(),
  z.object({kind:z.literal('fill'),field:label.optional(),text:z.string().max(10000),...conditional}).strict(),
  z.object({kind:z.literal('scroll'),direction:z.enum(['up','down','left','right']),...conditional}).strict(),
  z.object({kind:z.literal('choose'),goal:choiceSchema.shape.goal,labels:choiceSchema.shape.labels,exact_label:label.optional(),use_model:z.boolean().default(false),...conditional}).strict(),
  z.object({kind:z.literal('sequence'),labels:sequenceSchema.shape.labels,fixed_layout:z.literal(true),interval_ms:sequenceSchema.shape.interval_ms,...conditional}).strict(),
  z.object({kind:z.literal('app_action'),shortcut:label,input:appActionSchema.shape.input,...conditional,expect:stateGuard}).strict(),
]);
export const workflowSchema=z.object({device:label,expected_app:label,start:stateGuard,steps:z.array(steps).min(1).max(30),finish:stateGuard,timeout_seconds:z.number().int().min(1).max(120).default(120)}).strict();
export const snapshotQuerySchema=z.object({labels:z.array(label).min(1).max(80).optional(),roles:z.array(label).min(1).max(20).optional()}).strict()
  .refine(q=>q.labels||q.roles,'Specify labels or roles');
