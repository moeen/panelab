import { z } from 'zod'
import { rectSchema } from './inspection'

// Headless engines never stream a native <select> popup, so the page agent reports the options
// and PaneLab draws its own picker over the preview. Everything here comes from the website.
export const pickerOptionLimit = 500
export const pickerIdSchema = z.string().regex(/^[a-z\d]{1,40}$/)
export const pickerSchema = z.object({
  id: pickerIdSchema,
  label: z.string().max(200),
  options: z
    .array(
      z.object({
        label: z.string().max(200),
        group: z.string().max(200).nullable(),
        disabled: z.boolean(),
      }),
    )
    .min(1)
    .max(pickerOptionLimit),
  selectedIndex: z
    .number()
    .int()
    .min(-1)
    .max(pickerOptionLimit - 1),
  // The select's border box in the pane's CSS viewport pixels, like highlights.
  rect: rectSchema,
  viewport: z.object({
    width: z.number().positive().max(1_000_000),
    height: z.number().positive().max(1_000_000),
  }),
})
export type PagePicker = z.infer<typeof pickerSchema>
export const pickerMessageSchema = z.object({ kind: z.literal('picker'), picker: pickerSchema })
export const pickerIndexSchema = z
  .number()
  .int()
  .min(0)
  .max(pickerOptionLimit - 1)
