/**
 * The words of turning a project off, on, and deleting it, in its Overview:
 * what the confirmation says will happen, and what the result says did.
 * Pure. The server does each, see bin/cli/lifecycle.ts.
 */

export type LifecycleAction = "disable" | "enable" | "remove"

export type LifecycleTexts = {
  title: string
  consequence: string
  action: string
  actionRunning: string
  running: string
  succeeded: string
  failed: string
  after: string
}

export function lifecycleTexts(slug: string, action: LifecycleAction): LifecycleTexts {
  if (action === "disable") {
    return {
      title: `Turn off ${slug}?`,
      consequence: "Its services stop and every address it has says it is turned off. Nothing is deleted: its code, data, secrets, people with access and tokens stay, and turning it on brings it back as it was.",
      action: "Turn off",
      actionRunning: "Turning off...",
      running: `Turning off ${slug}`,
      succeeded: `${slug} is turned off`,
      failed: "Turning off failed",
      after: "Its addresses say it is turned off. Deploying it, changing its access and renaming it wait until it is turned on again.",
    }
  }
  if (action === "enable") {
    return {
      title: `Turn on ${slug}?`,
      consequence: "Its own block and its services come back, and it answers on its addresses again.",
      action: "Turn on",
      actionRunning: "Turning on...",
      running: `Turning on ${slug}`,
      succeeded: `${slug} is on again`,
      failed: "Turning on failed",
      after: "It answers on its addresses as before.",
    }
  }
  return {
    title: `Delete ${slug}?`,
    consequence:
      "Its services, files and data, secrets and system account are deleted from the server, for good. Its people with access lose it. Backup snapshots already taken stay. The repository's folder is not touched.",
    action: "Delete project",
    actionRunning: "Deleting...",
    running: `Deleting ${slug}`,
    succeeded: `${slug} is deleted`,
    failed: "Deleting failed",
    after: "It no longer exists on the server. Its folder in your repository is left to you: git rm -r it there.",
  }
}
