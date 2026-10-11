// An ERB template as Ruby: the code in its tags (<% %>, <%= %>, <%- -%>)
// where it is, with the HTML around it blanked to spaces (newlines kept), so
// every line is where it is in the template. Each tag's code is ended with
// `;` so neighbouring tags don't run together. Comments (<%# %>) and
// literal tags (<%% %>) are blanked too.
export function erbToRuby(text: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  let out = "";
  let at = 0;
  const tag = /<%(%|#)?(-|==|=)?([\s\S]*?)-?%>/g;
  for (let m = tag.exec(text); m; m = tag.exec(text)) {
    out += blank(text.slice(at, m.index));
    out += m[1] ? blank(m[0]) : `${blank(`<%${m[2] ?? ""}`)}${m[3]};`;
    at = m.index + m[0].length;
  }
  return out + blank(text.slice(at));
}
