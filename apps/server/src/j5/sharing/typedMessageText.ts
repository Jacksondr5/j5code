/**
 * Upstream surfaces that read a stored message's text get the words its author typed (#612). In a
 * shared conversation the stored text begins with the platform's lines for the agent, and
 * `j5_a2a_message_author.stored_prefix` names exactly that text, so only it is taken off; a message
 * no one is recorded for, or whose text does not begin with it, is read as stored. The agent still
 * reads the stored text. Plain SQL for upstream's queries to call (FORK.md case 86).
 */

const AUTHOR = "j5_message_author";

/**
 * Joins the author record of each row of `messages`, an alias of
 * `orchestration_v2_projection_messages`, for `typedMessageTextSql`. A lookup by primary key.
 */
export const messageAuthorJoinSql = (messages: string) => `
  LEFT JOIN j5_a2a_message_author AS ${AUTHOR}
    ON ${AUTHOR}.thread_id = ${messages}.thread_id
   AND ${AUTHOR}.message_id = ${messages}.message_id
`;

/**
 * The text of each row of `messages` without its recorded prefix; needs `messageAuthorJoinSql`.
 * With no author row the prefix is NULL, the comparison is NULL, and the text is read as stored.
 */
export const typedMessageTextSql = (messages: string) => {
  const text = `json_extract(${messages}.payload_json, '$.text')`;
  return `
    CASE
      WHEN substr(${text}, 1, length(${AUTHOR}.stored_prefix)) = ${AUTHOR}.stored_prefix
        THEN substr(${text}, length(${AUTHOR}.stored_prefix) + 1)
      ELSE ${text}
    END
  `;
};
