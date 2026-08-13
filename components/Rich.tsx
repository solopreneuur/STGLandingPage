import { Fragment } from "react";

/**
 * Renders model prose with two brand rules applied:
 *  - **phrase** becomes an accent highlight (the model marks the 1-2
 *    load-bearing phrases per field)
 *  - bare numbers render in Archivo Black, per the brand rule that ALL
 *    numbers use the numeric face
 */
const NUM = /(\$?\d[\d,.]*\s?(?:k|K|m|M|s|x|×|%)?)/g;

function withNumbers(text: string, keyPrefix: string) {
  return text.split(NUM).map((part, i) =>
    NUM.test(part) && /\d/.test(part) ? (
      <span key={`${keyPrefix}-n${i}`} className="font-num">
        {part}
      </span>
    ) : (
      <Fragment key={`${keyPrefix}-t${i}`}>{part}</Fragment>
    )
  );
}

export default function Rich({ text }: { text: string }) {
  if (!text) return null;
  // Split on **…**, keeping the delimited chunks.
  const chunks = text.split(/\*\*(.+?)\*\*/g);
  return (
    <>
      {chunks.map((chunk, i) =>
        i % 2 === 1 ? (
          <span key={`b${i}`} className="text-accent">
            {withNumbers(chunk, `b${i}`)}
          </span>
        ) : (
          <Fragment key={`p${i}`}>{withNumbers(chunk, `p${i}`)}</Fragment>
        )
      )}
    </>
  );
}
