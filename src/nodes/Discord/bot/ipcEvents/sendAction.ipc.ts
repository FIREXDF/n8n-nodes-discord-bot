import { Channel, Client, GuildMember, TextChannel, User, ChannelType } from 'discord.js'
import { Socket } from 'net'
import Ipc from 'node-ipc'

import { IDiscordNodeActionParameters } from '../../Discord.node'
import { addLog } from '../helpers'
import state from '../state'

export default function (ipc: typeof Ipc, client: Client) {
  ipc.server.on('send:action', (nodeParameters: IDiscordNodeActionParameters, socket: Socket) => {
    try {
      if (state.ready) {
        const executionMatching = state.executionMatching[nodeParameters.executionId]
        let channelId = ''
        if (nodeParameters.triggerPlaceholder || nodeParameters.triggerChannel) channelId = executionMatching?.channelId
        else channelId = nodeParameters.channelId

        if (!channelId && !nodeParameters.actionType) {
          ipc.server.emit(socket, 'send:action', false)
          return
        }

        client.channels
          .fetch(channelId)
          .then(async (channel: Channel | null): Promise<void> => {
            if (nodeParameters.actionType !== 'getLogs' && (!channel || (!channel.isTextBased() && channel.type !== ChannelType.GuildForum))) return

            const performAction = async () => {
              if (nodeParameters.actionType === 'removeMessages') {
                await (channel as TextChannel)
                  .bulkDelete(nodeParameters.removeMessagesNumber)
                  .catch((e: Error) => addLog(`${e}`, client))
              } else if (['addRole', 'removeRole'].includes(nodeParameters.actionType)) {
                await client.users
                  .fetch(nodeParameters.userId as string)
                  .then(async (user: User) => {
                    await (channel as TextChannel).guild.members
                      .fetch(user)
                      .then((member: GuildMember) => {
                        const roles = member.roles
                        const roleUpdateIds =
                          typeof nodeParameters.roleUpdateIds === 'string'
                            ? nodeParameters.roleUpdateIds.split(',')
                            : nodeParameters.roleUpdateIds
                          ; (roleUpdateIds ?? []).forEach((roleId: string) => {
                            if (!roles.cache.has(roleId) && nodeParameters.actionType === 'addRole')
                              roles.add(roleId, nodeParameters.auditLogReason)
                            else if (roles.cache.has(roleId) && nodeParameters.actionType === 'removeRole')
                              roles.remove(roleId, nodeParameters.auditLogReason)
                          })
                      })
                      .catch((e: Error) => addLog(`${e}`, client))
                  })
                  .catch((e: Error) => {
                    addLog(`${e}`, client)
                  })
              } else if (nodeParameters.actionType === 'createThread') {
                if (channel && 'threads' in channel) {
                  await channel.threads
                    .create({
                      name: nodeParameters.threadName || 'New Thread',
                      message: { content: nodeParameters.content || 'New thread created' },
                      reason: nodeParameters.auditLogReason,
                    })
                    .catch((e: Error) => addLog(`${e}`, client))
                }
              } else if (nodeParameters.actionType === 'renameThread') {
                if (channel?.isThread()) {
                  await channel
                    .setName(nodeParameters.threadName || channel.name, nodeParameters.auditLogReason)
                    .catch((e: Error) => addLog(`${e}`, client))
                }
              } else if (nodeParameters.actionType === 'closeThread') {
                if (channel?.isThread()) {
                  await channel
                    .setArchived(true, nodeParameters.auditLogReason)
                    .catch((e: Error) => addLog(`${e}`, client))
                }
              } else if (nodeParameters.actionType === 'getLogs') {
                const logs = state.logs.length > 0 ? state.logs.join('\n') : 'No logs available.'
                ipc.server.emit(socket, 'send:action', {
                  channelId,
                  action: nodeParameters.actionType,
                  value: logs, // Pass the logs back in the 'value' property
                })
                return true // Handled emit
              }
              return false
            }

            if (nodeParameters.triggerPlaceholder && executionMatching?.placeholderId) {
              const realPlaceholderId = state.placeholderMatching[executionMatching.placeholderId]
              if (realPlaceholderId && channel && 'messages' in channel) {
                const message = await channel.messages.fetch(realPlaceholderId).catch((e: Error) => {
                  addLog(`${e}`, client)
                })
                if (executionMatching.placeholderId) {
                  Reflect.deleteProperty(state.placeholderMatching, executionMatching.placeholderId)
                }
                if (message?.delete) {
                  let retryCount = 0
                  const retry = async () => {
                    if (state.placeholderWaiting[executionMatching.placeholderId] && retryCount < 10) {
                      retryCount++
                      setTimeout(() => retry(), 300)
                    } else {
                      await message.delete().catch((e: Error) => {
                        addLog(`${e}`, client)
                      })

                      const handled = await performAction()
                      if (!handled) {
                        ipc.server.emit(socket, 'send:action', {
                          channelId,
                          action: nodeParameters.actionType,
                        })
                      }
                    }
                  }
                  await retry()
                  return
                }
              }
            }

            const handled = await performAction()
            if (!handled) {
              ipc.server.emit(socket, 'send:action', {
                channelId,
                action: nodeParameters.actionType,
              })
            }
          })
          .catch((e: Error) => {
            addLog(`${e}`, client)
            ipc.server.emit(socket, 'send:action', false)
          })
      }
    } catch (e) {
      addLog(`${e}`, client)
      ipc.server.emit(socket, 'send:action', false)
    }
  })
}
