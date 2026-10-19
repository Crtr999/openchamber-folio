/** Small, non-evaluating spreadsheet interpreter. Cell content is never JavaScript. */
export const columnName = (index: number): string => {
  let value = index + 1;
  let result = '';
  while (value > 0) { value--; result = String.fromCharCode(65 + value % 26) + result; value = Math.floor(value / 26); }
  return result;
};
const cellPosition = (address: string) => {
  const match = /^([A-Z]+)([1-9]\d*)$/.exec(address);
  if (!match) throw new Error('#REF!');
  const column = [...match[1]].reduce((value, char) => value * 26 + char.charCodeAt(0) - 64, 0) - 1;
  return { row: Number(match[2]) - 1, column };
};
type Value = number | number[];
type Expression = () => Value;
const scalar = (value: Value) => { if (Array.isArray(value)) throw new Error('#VALUE!'); return value; };

export function calculateCell(rows: readonly (readonly string[])[], row: number, column: number, visiting = new Set<string>(), evaluation = { steps: 0, cache: new Map<string, string>() }): string {
  if (++evaluation.steps > 10_000) return '#LIMIT!';
  const source = rows[row]?.[column] ?? '';
  if (!source.startsWith('=')) return source;
  const key = `${row}:${column}`;
  if (visiting.has(key) || visiting.size > 100) return '#CYCLE!';
  const next = new Set(visiting).add(key);
  const read = (address: string) => {
    const position = cellPosition(address);
    if (position.row >= 500 || position.column >= 50) throw new Error('#REF!');
    const cached = evaluation.cache.get(address);
    const result = cached ?? calculateCell(rows, position.row, position.column, next, evaluation);
    evaluation.cache.set(address, result);
    if (result.startsWith('#')) throw new Error(result);
    if (!result.trim()) return 0;
    const numeric = Number(result);
    if (!Number.isFinite(numeric)) throw new Error('#VALUE!');
    return numeric;
  };
  try {
    const expression = source.slice(1).toUpperCase();
    if (expression.length > 2000) throw new Error('#LIMIT!');
    const tokens = expression.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:E[+-]?\d+)?|[A-Z]+[1-9]\d*|[A-Z]+|<>|<=|>=|[+\-*/^(),:=<>]|\S/g) ?? [];
    let cursor = 0;
    const take = (token: string) => tokens[cursor] === token && (++cursor > 0);
    const expect = (token: string) => { if (!take(token)) throw new Error('#FORMULA!'); };
    const primary = (): Expression => {
      if (take('+')) { const value = primary(); return () => scalar(value()); }
      if (take('-')) { const value = primary(); return () => -scalar(value()); }
      if (take('(')) { const value = comparison(); expect(')'); return value; }
      const token = tokens[cursor++];
      if (!token) throw new Error('#FORMULA!');
      if (/^(?:\d|\.)/.test(token)) return () => Number(token);
      if (/^[A-Z]+[1-9]\d*$/.test(token)) {
        if (!take(':')) return () => read(token);
        const end = cellPosition(tokens[cursor++] ?? '');
        const start = cellPosition(token);
        if (end.row >= 500 || end.column >= 50 || start.row >= 500 || start.column >= 50) throw new Error('#REF!');
        return () => {
          const values: number[] = [];
          for (let r = Math.min(start.row, end.row); r <= Math.max(start.row, end.row); r++) {
            for (let c = Math.min(start.column, end.column); c <= Math.max(start.column, end.column); c++) {
              const raw = rows[r]?.[c] ?? '';
              if (raw.startsWith('=') || (raw.trim() && Number.isFinite(Number(raw)))) values.push(read(`${columnName(c)}${r + 1}`));
            }
          }
          return values;
        };
      }
      if (!['SUM', 'AVERAGE', 'MIN', 'MAX', 'COUNT', 'IF'].includes(token)) throw new Error('#NAME?');
      expect('(');
      const argumentsList: Expression[] = [];
      if (!take(')')) { do { argumentsList.push(comparison()); } while (take(',')); expect(')'); }
      return () => {
        if (token === 'IF') {
          if (argumentsList.length !== 3) throw new Error('#FORMULA!');
          return scalar(argumentsList[0]()) ? argumentsList[1]() : argumentsList[2]();
        }
        const numbers = argumentsList.flatMap((argument) => argument());
        switch (token) {
        case 'SUM': return numbers.reduce((a, b) => a + b, 0);
        case 'AVERAGE': if (!numbers.length) throw new Error('#DIV/0!'); return numbers.reduce((a, b) => a + b, 0) / numbers.length;
        case 'MIN': return numbers.length ? Math.min(...numbers) : 0;
        case 'MAX': return numbers.length ? Math.max(...numbers) : 0;
        case 'COUNT': return numbers.length;
        default: throw new Error('#NAME?');
        }
      };
    };
    const power = (): Expression => { const left = primary(); if (!take('^')) return left; const right = power(); return () => scalar(left()) ** scalar(right()); };
    const multiply = (): Expression => {
      let value = power();
      while (tokens[cursor] === '*' || tokens[cursor] === '/') {
        const operator = tokens[cursor++]; const right = power(); const left = value;
        value = () => { const a = scalar(left()); const b = scalar(right()); if (operator === '/' && b === 0) throw new Error('#DIV/0!'); return operator === '*' ? a * b : a / b; };
      }
      return value;
    };
    const add = (): Expression => { let value = multiply(); while (tokens[cursor] === '+' || tokens[cursor] === '-') { const operator = tokens[cursor++]; const right = multiply(); const left = value; value = () => operator === '+' ? scalar(left()) + scalar(right()) : scalar(left()) - scalar(right()); } return value; };
    function comparison(): Expression {
      const left = add(); const operator = tokens[cursor];
      if (!['=', '<>', '<', '>', '<=', '>='].includes(operator)) return left;
      cursor++; const right = add();
      return () => { const a = scalar(left()); const b = scalar(right()); return Number(operator === '=' ? a === b : operator === '<>' ? a !== b : operator === '<' ? a < b : operator === '>' ? a > b : operator === '<=' ? a <= b : a >= b); };
    }
    const expressionResult = comparison();
    if (cursor !== tokens.length) throw new Error('#FORMULA!');
    const value = scalar(expressionResult());
    return Number.isFinite(value) ? String(Number(value.toPrecision(12))) : '#NUM!';
  } catch (error) { return error instanceof Error && error.message.startsWith('#') ? error.message : '#FORMULA!'; }
}
