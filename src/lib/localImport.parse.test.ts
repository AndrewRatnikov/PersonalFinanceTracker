// No CONTRACT_GAPs: parseCSV, detectDelimiter and parseAmount are fully
// specified in the Interface Contract (module: localImport).

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  detectDelimiter,
  importExpensesFromCSV,
  importIncomeFromCSV,
  importLocalDataFile,
  parseAmount,
  parseCSV,
} from '@/lib/localImport'
import {
  addExpense,
  addIncome,
  getAllCategories,
  getAllExpenses,
  getAllIncome,
} from '@/lib/localDb'

vi.mock('@/lib/localDb', () => ({
  addCategory: vi.fn(),
  addExpense: vi.fn(),
  addIncome: vi.fn(),
  getAllCategories: vi.fn(),
  getAllExpenses: vi.fn(),
  getAllIncome: vi.fn(),
  upsertBudget: vi.fn(),
}))

describe('parseCSV basics', () => {
  it('parses a header and rows into records keyed by header name', () => {
    const rows = parseCSV('a,b,c\n1,2,3\n4,5,6')

    expect(rows).toEqual([
      { a: '1', b: '2', c: '3' },
      { a: '4', b: '5', c: '6' },
    ])
  })

  it('returns nothing for empty input or a header only', () => {
    expect(parseCSV('')).toEqual([])
    expect(parseCSV('a,b,c')).toEqual([])
    expect(parseCSV('a,b,c\n')).toEqual([])
  })

  it('strips a leading BOM from the first header name', () => {
    const rows = parseCSV('﻿date,amount\n2024-01-01,5')

    expect(Object.keys(rows[0])).toEqual(['date', 'amount'])
    expect(rows[0].date).toBe('2024-01-01')
  })

  it('handles CRLF line endings', () => {
    const rows = parseCSV('a,b\r\n1,2\r\n3,4\r\n')

    expect(rows).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ])
  })

  it('skips blank lines', () => {
    const rows = parseCSV('a,b\n\n1,2\n\n\n3,4\n')

    expect(rows).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ])
  })

  it('trims unquoted fields and header names', () => {
    const rows = parseCSV(' a , b \n  1 ,  two words  ')

    expect(rows).toEqual([{ a: '1', b: 'two words' }])
  })

  it('keeps quoted fields verbatim, including surrounding spaces', () => {
    const rows = parseCSV('a,b\n"  padded  ",x')

    expect(rows[0].a).toBe('  padded  ')
    expect(rows[0].b).toBe('x')
  })

  it('fills missing trailing columns with empty strings', () => {
    const rows = parseCSV('a,b,c\n1\n2,3')

    expect(rows).toEqual([
      { a: '1', b: '', c: '' },
      { a: '2', b: '3', c: '' },
    ])
  })

  it('keeps empty fields in the middle', () => {
    expect(parseCSV('a,b,c\n1,,3')).toEqual([{ a: '1', b: '', c: '3' }])
  })
})

describe('parseCSV quoting', () => {
  it('keeps a comma inside quotes in the value', () => {
    const rows = parseCSV('name,note\n"Smith, John",ok')

    expect(rows[0].name).toBe('Smith, John')
    expect(rows[0].note).toBe('ok')
  })

  it('turns "" into a literal quote', () => {
    const rows = parseCSV('a\n"say ""hi"" now"')

    expect(rows[0].a).toBe('say "hi" now')
  })

  it('keeps a newline inside quotes as part of the value', () => {
    const rows = parseCSV('a,b\n"line one\nline two",x\n"y",z')

    expect(rows).toEqual([
      { a: 'line one\nline two', b: 'x' },
      { a: 'y', b: 'z' },
    ])
  })

  it('keeps a CRLF inside quotes verbatim and still splits records on CRLF', () => {
    const rows = parseCSV('a,b\r\n"one\r\ntwo",x\r\n"three",y\r\n')

    expect(rows).toEqual([
      { a: 'one\r\ntwo', b: 'x' },
      { a: 'three', b: 'y' },
    ])
  })

  it('handles an escaped quote next to a comma and a newline', () => {
    const rows = parseCSV('a,b\n"x"",y\n""z",1')

    expect(rows).toEqual([{ a: 'x",y\n"z', b: '1' }])
  })

  it('takes the rest of the text as the value for an unterminated quote', () => {
    const rows = parseCSV('a,b\n1,"never closed\nstill going')

    expect(rows).toHaveLength(1)
    expect(rows[0].a).toBe('1')
    expect(rows[0].b).toBe('never closed\nstill going')
  })

  it('reads a quoted header', () => {
    const rows = parseCSV('"date","amount"\n"2024-01-01","5"')

    expect(rows).toEqual([{ date: '2024-01-01', amount: '5' }])
  })
})

describe('detectDelimiter', () => {
  it('detects a comma header', () => {
    expect(detectDelimiter('a,b,c\n1,2,3')).toBe(',')
  })

  it('detects a semicolon header', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';')
  })

  it('prefers a comma on a tie', () => {
    expect(detectDelimiter('a;b,c\n1;2,3')).toBe(',')
    expect(detectDelimiter('single\n1')).toBe(',')
  })

  it('does not count delimiters inside quotes', () => {
    expect(detectDelimiter('"a;b;c;d",e,f\n1,2,3')).toBe(',')
    expect(detectDelimiter('"a,b,c,d";e;f\n1;2;3')).toBe(';')
  })

  it('looks at the header only, not at the body', () => {
    expect(detectDelimiter('a,b\n1;2;3;4;5;6;7')).toBe(',')
    expect(detectDelimiter('a;b\n1,2,3,4,5,6,7')).toBe(';')
  })
})

describe('parseCSV with a semicolon delimiter', () => {
  it('splits on semicolons and keeps decimal commas intact', () => {
    const rows = parseCSV('date;amount;currency\n2024-01-15;12,50;UAH')

    expect(rows).toEqual([
      { date: '2024-01-15', amount: '12,50', currency: 'UAH' },
    ])
  })

  it('keeps a semicolon inside quotes and handles CRLF and a BOM', () => {
    const rows = parseCSV(
      '﻿a;b\r\n"x;y";z\r\n"multi\nline";w\r\n',
    )

    expect(rows).toEqual([
      { a: 'x;y', b: 'z' },
      { a: 'multi\nline', b: 'w' },
    ])
  })
})

describe('parseAmount', () => {
  it('parses plain numbers', () => {
    expect(parseAmount('12')).toBe(12)
    expect(parseAmount('12.5')).toBe(12.5)
    expect(parseAmount(' 7 ')).toBe(7)
  })

  it('accepts a decimal comma', () => {
    expect(parseAmount('12,50')).toBe(12.5)
    expect(parseAmount('0,99')).toBe(0.99)
    expect(parseAmount('-3,5')).toBe(-3.5)
  })

  it('removes spaces and non-breaking spaces used as thousands separators', () => {
    expect(parseAmount('1 234,50')).toBe(1234.5)
    expect(parseAmount('1 234,50')).toBe(1234.5)
    expect(parseAmount('1 234 567')).toBe(1234567)
  })

  it('is NaN for empty or non-numeric input', () => {
    expect(Number.isNaN(parseAmount(''))).toBe(true)
    expect(Number.isNaN(parseAmount('   '))).toBe(true)
    expect(Number.isNaN(parseAmount('abc'))).toBe(true)
  })

  it('does not guess at ambiguous separators', () => {
    expect(Number.isNaN(parseAmount('1,234,567'))).toBe(true)
  })
})

describe('imports use the new parser', () => {
  const FOOD = { id: 'c1', name: 'Food', icon: null }

  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(getAllCategories).mockResolvedValue([FOOD])
    vi.mocked(getAllExpenses).mockResolvedValue([])
    vi.mocked(getAllIncome).mockResolvedValue([])
  })

  it('a semicolon-delimited expenses file with decimal commas imports', async () => {
    const csv = [
      'date;amount;currency;category;description',
      '2024-01-15;12,50;UAH;Food;lunch',
      '2024-01-16;1 200,00;UAH;Food;rent share',
    ].join('\r\n')

    const result = await importExpensesFromCSV(csv)

    expect(result.errors).toEqual([])
    expect(result.inserted).toBe(2)
    const amounts = vi.mocked(addExpense).mock.calls.map((c) => c[0].amount)
    expect(amounts).toEqual([12.5, 1200])
    const descriptions = vi
      .mocked(addExpense)
      .mock.calls.map((c) => c[0].description)
    expect(descriptions).toEqual(['lunch', 'rent share'])
  })

  it('a semicolon-delimited income file imports', async () => {
    const csv = [
      'date;source;amount;currency;description',
      '2024-01-15;Job;1500,75;USD;',
    ].join('\n')

    const result = await importIncomeFromCSV(csv)

    expect(result.inserted).toBe(1)
    expect(vi.mocked(addIncome).mock.calls[0][0].amount).toBe(1500.75)
    expect(vi.mocked(addIncome).mock.calls[0][0].source).toBe('Job')
  })

  it('a quoted multi-line description reaches addExpense unchanged', async () => {
    const csv =
      'date,amount,currency,category,description\n' +
      '2024-01-15,10,UAH,Food,"first line\nsecond, line with ""quotes"""\n' +
      '2024-01-16,11,UAH,Food,plain'

    const result = await importExpensesFromCSV(csv)

    expect(result.inserted).toBe(2)
    expect(vi.mocked(addExpense).mock.calls[0][0].description).toBe(
      'first line\nsecond, line with "quotes"',
    )
    expect(vi.mocked(addExpense).mock.calls[1][0].amount).toBe(11)
  })

  it('an invalid decimal-comma amount is still reported per row', async () => {
    const result = await importExpensesFromCSV(
      ['date;amount;currency;category;description', '2024-01-15;abc;UAH;Food;'].join(
        '\n',
      ),
    )

    expect(result.inserted).toBe(0)
    expect(result.skipped).toBe(1)
    expect(result.errors).toContain('Row 2: invalid amount "abc"')
  })

  it('importLocalDataFile sniffs a semicolon file by its header', async () => {
    const csv = 'date;amount;currency;category;description\n2024-01-15;5,5;UAH;Food;x'
    const file = Object.assign(new File([csv], 'export.csv'), {
      text: () => Promise.resolve(csv),
    })

    const { type, result } = await importLocalDataFile(file)

    expect(type).toBe('expenses')
    expect(result.inserted).toBe(1)
    expect(vi.mocked(addExpense).mock.calls[0][0].amount).toBe(5.5)
  })
})
