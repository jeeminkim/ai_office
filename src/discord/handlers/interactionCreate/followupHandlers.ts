import { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { detectFinancialIntent } from '../../analysisFormatting';
import { getFollowupSnapshotById, type FollowupSnapshotRow } from '../../../repositories/followupRepository';
import type { DiscordInteractionContext } from '../../InteractionContext';

function decodeOpenTopicAmbiguousRef(ref: string | null): string {
  if (!ref || !ref.startsWith('otamb:')) return '';
  try {
    return Buffer.from(ref.slice('otamb:'.length), 'base64url').toString('utf8');
  } catch {
    return '';
  }
}

function buildFollowupQueryFromLabel(label: string): string {
  const s = label.toLowerCase();
  if (/포트폴리오|자산|비중|점검/.test(s)) {
    return '내 포트폴리오 전체를 점검하고 핵심 리스크와 다음 조치를 제안해줘.';
  }
  if (/종목|전략|심화/.test(s)) {
    return '보유 종목과 투자 전략을 심화 분석하고 실행 가능한 다음 단계를 제안해줘.';
  }
  if (/트렌드|시장|이슈/.test(s)) {
    return '최근 시장·트렌드 이슈가 내 포트폴리오에 미칠 수 있는 영향을 요약해줘.';
  }
  return `${label}에 대해 구체적으로 분석하고 다음 행동을 제안해줘.`;
}

async function runFollowupContinuation(
  interaction: any,
  ctx: DiscordInteractionContext,
  snap: FollowupSnapshotRow,
  optionIndex: number,
  label: string
): Promise<void> {
  const userId = interaction.user.id;

  if (snap.analysis_type === 'open_topic_ambiguous_view') {
    const storedQuery = decodeOpenTopicAmbiguousRef(snap.chat_history_ref);
    ctx.logger.info('FOLLOWUP', 'FOLLOWUP_SELECTED', {
      user_id: userId,
      snapshot_id: snap.id,
      option_index: optionIndex,
      label: label.slice(0, 200),
      analysis_type: snap.analysis_type
    });
    ctx.updateHealth(s => {
      s.ux.lastFollowupSelectedAt = new Date().toISOString();
    });
    if (!storedQuery.trim()) {
      await ctx.interactions.safeDeferReply(interaction, { flags: 64 });
      await interaction.editReply({ content: '세션이 만료되었거나 복원할 질문을 찾을 수 없습니다.' });
      return;
    }
    let view: 'financial' | 'trend' | 'general' = 'general';
    if (/금융/.test(label)) view = 'financial';
    else if (/트렌드/.test(label)) view = 'trend';
    ctx.logger.info('OPEN_TOPIC', 'OPEN_TOPIC_VIEW_SELECTED', {
      view,
      discordUserId: ctx.getDiscordUserId(interaction.user),
      snapshot_id: snap.id,
      label: label.slice(0, 120)
    });
    ctx.logger.info('FOLLOWUP', 'FOLLOWUP_EXECUTION_STARTED', {
      user_id: userId,
      execution_type: 'open_topic_ambiguous_view',
      selected_option: label.slice(0, 200)
    });
    await interaction.deferReply({ ephemeral: false });
    await interaction.editReply({
      content: `**선택:** ${label.slice(0, 200)}\n선택한 관점으로 분석을 실행합니다… _(자동 주문 없음)_`
    });
    try {
      await ctx.runtime.runOpenTopicDebate(userId, storedQuery, interaction, { forcedOpenTopicView: view });
      ctx.logger.info('FOLLOWUP', 'FOLLOWUP_EXECUTION_COMPLETED', {
        user_id: userId,
        analysis_type: snap.analysis_type,
        execution_type: 'open_topic_view_selected',
        selected_option: label.slice(0, 200)
      });
      await interaction.editReply({
        content: '**후속 분석이 채널에 전송되었습니다.** _(자동 주문 없음)_'
      });
    } catch (e: unknown) {
      ctx.logger.warn('FOLLOWUP', 'open_topic_ambiguous_continuation_failed', {
        message: e instanceof Error ? e.message : String(e)
      });
      await interaction.editReply({
        content: '후속 분석 중 문제가 있었습니다. 잠시 후 다시 시도해 주세요. _(자동 주문 없음)_'
      });
    }
    return;
  }

  ctx.logger.info('FOLLOWUP', 'FOLLOWUP_SELECTED', {
    user_id: userId,
    snapshot_id: snap.id,
    option_index: optionIndex,
    label: label.slice(0, 200),
    analysis_type: snap.analysis_type
  });
  ctx.updateHealth(s => {
    s.ux.lastFollowupSelectedAt = new Date().toISOString();
  });
  ctx.logger.info('FOLLOWUP', 'FOLLOWUP_EXECUTION_STARTED', {
    user_id: userId,
    execution_type: 'followup',
    selected_option: label.slice(0, 200)
  });
  await interaction.deferReply({ ephemeral: false });
  await interaction.editReply({
    content: `**선택:** ${label.slice(0, 200)}\n후속 분석을 실행합니다… _(자동 주문 없음)_`
  });
  const query = buildFollowupQueryFromLabel(label);
  const low = label.toLowerCase();
  const fin = detectFinancialIntent(query);
  let execLabel = 'open_topic_followup';
  try {
    if (/트렌드|시장\s*이슈|핫\s*이슈/.test(low) && !fin) {
      await ctx.runtime.runTrendAnalysis(userId, query, interaction, 'free', undefined);
      execLabel = 'trend_followup';
    } else if (fin) {
      await ctx.runtime.runPortfolioDebate(userId, query, interaction);
      execLabel = 'portfolio_followup';
    } else {
      await ctx.runtime.runOpenTopicDebate(userId, query, interaction);
    }
    ctx.logger.info('FOLLOWUP', 'FOLLOWUP_EXECUTION_COMPLETED', {
      user_id: userId,
      analysis_type: snap.analysis_type,
      execution_type: execLabel,
      selected_option: label.slice(0, 200)
    });
    await interaction.editReply({
      content: '**후속 분석이 채널에 전송되었습니다.** _(자동 주문 없음)_'
    });
  } catch (e: unknown) {
    ctx.logger.warn('FOLLOWUP', 'runFollowupContinuation failed', {
      message: e instanceof Error ? e.message : String(e)
    });
    await interaction.editReply({
      content: '후속 분석 중 문제가 있었습니다. 잠시 후 다시 시도해 주세요. _(자동 주문 없음)_'
    });
  }
}

export async function handleFollowupSelectButton(interaction: any, ctx: DiscordInteractionContext): Promise<void> {
  const cid = interaction.customId as string;
  const m = /^followup:select\|([0-9a-f-]{36})\|(\d+)$/i.exec(cid);
  if (!m) {
    await interaction.reply({ content: '잘못된 요청 형식입니다.', ephemeral: true }).catch(() => {});
    return;
  }
  const snap = await getFollowupSnapshotById(m[1]);
  const discordUserId = ctx.getDiscordUserId(interaction.user);
  if (!snap || snap.discord_user_id !== discordUserId) {
    await ctx.interactions.safeDeferReply(interaction, { flags: 64 });
    await interaction.editReply({ content: '세션이 만료되었거나 권한이 없습니다.' });
    return;
  }
  const idx = Number(m[2]);
  const label = snap.options[idx] ?? '';
  if (!label) {
    await ctx.interactions.safeDeferReply(interaction, { flags: 64 });
    await interaction.editReply({ content: '선택 항목을 찾을 수 없습니다.' });
    return;
  }
  await runFollowupContinuation(interaction, ctx, snap, idx, label);
}

export async function handleFollowupMenuInteraction(
  interaction: any,
  ctx: DiscordInteractionContext
): Promise<void> {
  const sid = interaction.customId as string;
  const m = /^followup:menu\|([0-9a-f-]{36})$/i.exec(sid);
  if (!m) {
    await interaction.reply({ content: '잘못된 요청 형식입니다.', ephemeral: true }).catch(() => {});
    return;
  }
  const snap = await getFollowupSnapshotById(m[1]);
  const discordUserId = ctx.getDiscordUserId(interaction.user);
  if (!snap || snap.discord_user_id !== discordUserId) {
    await interaction.reply({ content: '세션이 만료되었거나 권한이 없습니다.', ephemeral: true });
    return;
  }
  const idx = parseInt(interaction.values?.[0] ?? '0', 10);
  const label = snap.options[idx] ?? '';
  if (!label) {
    await interaction.reply({ content: '선택 항목을 찾을 수 없습니다.', ephemeral: true });
    return;
  }
  await runFollowupContinuation(interaction, ctx, snap, idx, label);
}

export async function handleFollowupInputButton(interaction: any, ctx: DiscordInteractionContext): Promise<void> {
  const cid = interaction.customId as string;
  const m = /^followup:input\|([0-9a-f-]{36})$/i.exec(cid);
  if (!m) {
    await interaction.reply({ content: '잘못된 요청 형식입니다.', ephemeral: true }).catch(() => {});
    return;
  }
  const snap = await getFollowupSnapshotById(m[1]);
  const discordUserId = ctx.getDiscordUserId(interaction.user);
  if (!snap || snap.discord_user_id !== discordUserId) {
    await interaction.reply({ content: '세션이 만료되었거나 권한이 없습니다.', ephemeral: true });
    return;
  }
  const modal = new ModalBuilder()
    .setCustomId(`modal:followup:${m[1]}`)
    .setTitle('답변 입력')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('followup_text')
          .setLabel('다음 분석에 반영할 내용')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(2000)
      )
    );
  await interaction.showModal(modal);
}

export async function handleFollowupModalSubmit(interaction: any, ctx: DiscordInteractionContext): Promise<void> {
  const cid = interaction.customId as string;
  const m = /^modal:followup:([0-9a-f-]{36})$/i.exec(cid);
  if (!m) {
    await interaction.reply({ content: '잘못된 요청 형식입니다.', ephemeral: true }).catch(() => {});
    return;
  }
  const snap = await getFollowupSnapshotById(m[1]);
  const userId = ctx.getDiscordUserId(interaction.user);
  if (!snap || snap.discord_user_id !== userId) {
    await ctx.interactions.safeDeferReply(interaction, { flags: 64 });
    await interaction.editReply({ content: '세션이 만료되었거나 권한이 없습니다.' });
    return;
  }
  const text = (interaction.fields.getTextInputValue('followup_text') || '').trim();
  if (!text) {
    await ctx.interactions.safeDeferReply(interaction, { flags: 64 });
    await interaction.editReply({ content: '내용을 입력해 주세요.' });
    return;
  }
  ctx.logger.info('FOLLOWUP', 'FOLLOWUP_INPUT_SUBMITTED', { user_id: userId, snapshot_id: snap.id });
  ctx.logger.info('FOLLOWUP', 'FOLLOWUP_EXECUTION_STARTED', { user_id: userId, execution_type: 'free_input' });
  await interaction.deferReply({ ephemeral: false });
  await interaction.editReply({ content: '입력을 반영해 분석을 시작합니다… _(자동 주문 없음)_' });
  const query = `${text}\n\n위 내용을 반영해 구체적으로 분석하고 다음 행동을 제안해줘.`;
  try {
    if (detectFinancialIntent(query)) {
      await ctx.runtime.runPortfolioDebate(userId, query, interaction);
    } else {
      await ctx.runtime.runOpenTopicDebate(userId, query, interaction);
    }
    ctx.logger.info('FOLLOWUP', 'FOLLOWUP_EXECUTION_COMPLETED', {
      user_id: userId,
      analysis_type: snap.analysis_type,
      execution_type: 'free_input_followup'
    });
    await interaction.editReply({
      content: '**후속 분석이 채널에 전송되었습니다.** _(자동 주문 없음)_'
    });
  } catch (e: unknown) {
    ctx.logger.warn('FOLLOWUP', 'modal followup failed', {
      message: e instanceof Error ? e.message : String(e)
    });
    await interaction.editReply({
      content: '후속 분석 중 문제가 있었습니다. 잠시 후 다시 시도해 주세요.'
    });
  }
}
