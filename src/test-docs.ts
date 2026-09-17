// Each <Runnable> on a docs page with a fence in that language, numbered among all of the page's runnables
export const runnablesOf = (file: string, source: string, fence: 'js' | 'py') =>
  Array.from(source.matchAll(/<Runnable( page)?>([\s\S]*?)<\/Runnable>/g)).flatMap((match, index) => {
    const code = new RegExp(`\`\`\`${fence}\\n([\\s\\S]*?)\`\`\``).exec(match[2]!)?.[1];
    return code === undefined ? [] : [{ name: `${file} example ${index + 1}`, code, page: match[1] !== undefined }];
  });
