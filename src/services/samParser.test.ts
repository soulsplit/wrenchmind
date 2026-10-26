import { describe, expect, it } from 'vitest'
import { parseSamStream } from './samParser'

interface TestEvent {
  type: string
  delta: string
  item_id: string
  output_index: number
  content_index: number
}

async function* events(text: string): AsyncGenerator<TestEvent> {
  yield {
    type: 'response.output_text.delta',
    delta: text,
    item_id: 'msg_1',
    output_index: 0,
    content_index: 0,
  }
}

/**
 * Golden mask payloads generated with the reference meta_sam_parser encoder
 * (one_bit). Each maps to its expected row-major raster.
 */
const MASKS = {
  checker3x2: { data: '2,3,!!!!!&[{Vkw', raster: [1, 0, 1, 0, 1, 0] },
  oneZero2x1: { data: '1,2,!!!!!&O.lVP', raster: [1, 0] },
  zeroOne2x1: { data: '1,2,!!!!!&LV9d7', raster: [0, 1] },
  full2x1: { data: '1,2,!!!!!&dc6D7', raster: [1, 1] },
  bordered4x3: { data: "3,4,!!!!!'IUK/e!!", raster: [0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0] },
  empty2x2: { data: '2,2,!!!!!&!!!!!', raster: [0, 0, 0, 0] },
} as const

function maskTag(data: string): string {
  return `<|mask;x=0;y=0;data=${data}|>`
}

/** Box tag with inclusive corners; w/h are source dims per the wire grammar. */
function boxTag(id: number, left: number, top: number, width: number, height: number): string {
  return (
    `${id}<|box;x1=${left};y1=${top};x2=${left + width - 1};y2=${top + height - 1}` +
    `;w=100;h=100|>`
  )
}

describe('parseSamStream', () => {
  it('decodes one record with its box, id, and raster', async () => {
    const line = `<0f>${boxTag(0, 10, 20, 3, 2)}${maskTag(MASKS.checker3x2.data)}`
    const recs = await parseSamStream(events(line))
    expect(recs).toHaveLength(1)
    expect(recs[0].frame).toBe(0)
    expect(recs[0].ordinal).toBe(0)
    expect(recs[0].objectId).toBe('0')
    expect(recs[0].box).toEqual({ x1: 10, y1: 20, x2: 12, y2: 21, w: 3, h: 2 })
    expect(Array.from(recs[0].raster)).toEqual(MASKS.checker3x2.raster)
  })

  it('keeps sparse object ids instead of positional ordinals', async () => {
    const first = `${boxTag(0, 0, 0, 2, 1)}${maskTag(MASKS.oneZero2x1.data)}`
    const second = `${boxTag(2, 5, 5, 2, 1)}${maskTag(MASKS.zeroOne2x1.data)}`
    const recs = await parseSamStream(events(`<0f>${first},${second}`))
    expect(recs.map((r) => r.objectId)).toEqual(['0', '2'])
    expect(recs.map((r) => r.ordinal)).toEqual([0, 1])
    expect(recs[0].box).toEqual({ x1: 0, y1: 0, x2: 0, y2: 0, w: 1, h: 1 })
    expect(Array.from(recs[0].raster)).toEqual([1])
    expect(recs[1].box).toEqual({ x1: 6, y1: 5, x2: 6, y2: 5, w: 1, h: 1 })
    expect(Array.from(recs[1].raster)).toEqual([1])
  })

  it('crops boxes to the tight bounds of set pixels', async () => {
    const line = `<0f>${boxTag(0, 10, 20, 4, 3)}${maskTag(MASKS.bordered4x3.data)}`
    const recs = await parseSamStream(events(line))
    expect(recs).toHaveLength(1)
    expect(recs[0].box).toEqual({ x1: 11, y1: 21, x2: 12, y2: 21, w: 2, h: 1 })
    expect(Array.from(recs[0].raster)).toEqual([1, 1])
  })

  it('keeps the model box when the raster is empty', async () => {
    const line = `<0f>${boxTag(0, 10, 20, 2, 2)}${maskTag(MASKS.empty2x2.data)}`
    const recs = await parseSamStream(events(line))
    expect(recs).toHaveLength(1)
    expect(recs[0].box).toEqual({ x1: 10, y1: 20, x2: 11, y2: 21, w: 2, h: 2 })
    expect(Array.from(recs[0].raster)).toEqual([0, 0, 0, 0])
  })

  it('returns no records for empty output (zero matches)', async () => {
    await expect(parseSamStream(events(''))).resolves.toEqual([])
  })

  it('decodes a real captured response (256px source, 128px mask)', async () => {
    const line =
      '<0f>0<|box;x1=64;y1=64;x2=191;y2=191;w=256;h=256|>' +
      '<|mask;x=0;y=0;data=128,128,!!!!!/Nb6qS75yyb`%TWt|>'
    const recs = await parseSamStream(events(line))
    expect(recs).toHaveLength(1)
    expect(recs[0].objectId).toBe('0')
    expect(recs[0].box).toEqual({ x1: 64, y1: 64, x2: 191, y2: 191, w: 128, h: 128 })
    expect(recs[0].raster).toHaveLength(16384)
    let ones = 0
    for (const v of recs[0].raster) ones += v
    expect(ones).toBe(16380)
  })

  it('tolerates confidence fields on boxes and masks', async () => {
    const line =
      '<0f>0<|box;x1=0;y1=0;x2=1;y2=0;w=100;h=100;c=0.5|>' +
      maskTag(MASKS.full2x1.data).replace('data=', 'c=0.5;data=')
    const recs = await parseSamStream(events(line))
    expect(recs).toHaveLength(1)
    expect(recs[0].box).toMatchObject({ x1: 0, y1: 0, x2: 1, y2: 0 })
    expect(Array.from(recs[0].raster)).toEqual(MASKS.full2x1.raster)
  })

  it('skips undecodable masks without dropping good records', async () => {
    const good = `${boxTag(0, 0, 0, 2, 1)}${maskTag(MASKS.oneZero2x1.data)}`
    const bad =
      '1<|box;x1=5;y1=5;x2=6;y2=5;w=100;h=100|><|mask;x=0;y=0;data=2,1,!x|>'
    const recs = await parseSamStream(events(`<0f>${good},${bad}`))
    expect(recs.map((r) => r.objectId)).toEqual(['0'])
  })
})
