export function cleanText(value: unknown) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

export function firstValue(...values: unknown[]) {
  return values.find((value) => cleanText(value)) || ''
}

export function parseWeekRange(weekText: unknown) {
  const weeks: number[] = []
  const matches = String(weekText || '').match(/\d+\s*(?:-\s*\d+)?/g) || []

  for (const match of matches) {
    const [startText, endText] = match.split('-').map((item) => item.trim())
    const start = Number(startText)
    const end = Number(endText || startText)

    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      continue
    }

    for (let week = Math.min(start, end); week <= Math.max(start, end); week += 1) {
      weeks.push(week)
    }
  }

  return [...new Set(weeks)].sort((a, b) => a - b)
}

export function parseSections(sectionText: unknown) {
  const match = String(sectionText || '').match(/(\d+)\s*-\s*(\d+)|(\d+)/)

  if (!match) {
    return []
  }

  const start = Number(match[1] || match[3])
  const end = Number(match[2] || match[1] || match[3])

  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return []
  }

  return Array.from(
    { length: Math.max(Math.abs(end - start) + 1, 1) },
    (_, index) => Math.min(start, end) + index,
  )
}

export function maskStudentId(studentId: unknown) {
  const value = String(studentId || '')

  if (value.length <= 4) {
    return value
  }

  return `${value.slice(0, 2)}****${value.slice(-2)}`
}

export function getTextFromHtml(html: unknown) {
  return cleanText(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' '),
  )
}

