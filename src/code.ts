const GAP = 40

const POSITION_EMOJI: Record<string, string> = {
  '右侧': '👉',
  '左侧': '👈',
  '上方': '👆',
  '下方': '👇'
}

function getPositionEmoji(position: string): string {
  for (const [key, emoji] of Object.entries(POSITION_EMOJI)) {
    if (position.includes(key)) {
      return emoji
    }
  }
  return '📍'
}

function findRootContainer(node: SceneNode): SceneNode | null {
  let current = node.parent
  let lastValidContainer: SceneNode | null = null

  while (current) {
    if (current.type === 'PAGE') {
      break
    }

    if (
      current.type === 'FRAME' ||
      current.type === 'COMPONENT' ||
      current.type === 'COMPONENT_SET' ||
      current.type === 'GROUP' ||
      'children' in current
    ) {
      lastValidContainer = current
    }

    current = current.parent
  }

  return lastValidContainer
}

function checkOverlap(
  x: number,
  y: number,
  width: number,
  height: number,
  nodes: SceneNode[],
  excludeIds: string[]
): boolean {
  for (const node of nodes) {
    if (excludeIds.includes(node.id)) continue

    const buffer = 10
    if (
      x < node.x + node.width + buffer &&
      x + width + buffer > node.x &&
      y < node.y + node.height + buffer &&
      y + height + buffer > node.y
    ) {
      return true
    }
  }
  return false
}

function calculateSmartPosition(
  targetNode: SceneNode,
  componentWidth: number,
  componentHeight: number,
  excludeIds: string[],
  checkNodes?: SceneNode[]
): { x: number; y: number; position: string } {
  const frameX = targetNode.x
  const frameY = targetNode.y
  const frameWidth = targetNode.width
  const frameHeight = targetNode.height

  const allNodes = checkNodes || (figma.currentPage.children as SceneNode[])

  const candidates = [
    { x: frameX + frameWidth + GAP, y: frameY, name: '右侧', priority: 1 },
    { x: frameX - componentWidth - GAP, y: frameY, name: '左侧', priority: 2 },
    { x: frameX, y: frameY - componentHeight - GAP, name: '上方', priority: 3 },
    { x: frameX, y: frameY + frameHeight + GAP, name: '下方', priority: 4 }
  ]

  const sortedCandidates = candidates.sort((a, b) => a.priority - b.priority)

  for (const candidate of sortedCandidates) {
    if (
      !checkOverlap(candidate.x, candidate.y, componentWidth, componentHeight, allNodes, excludeIds)
    ) {
      return { x: candidate.x, y: candidate.y, position: candidate.name }
    }
  }

  const gridOffsets = [
    { dx: frameWidth + GAP, dy: 0 },
    { dx: -(componentWidth + GAP), dy: 0 },
    { dx: 0, dy: -(componentHeight + GAP) },
    { dx: 0, dy: frameHeight + GAP },
    { dx: frameWidth + GAP, dy: frameHeight / 2 },
    { dx: -(componentWidth + GAP), dy: frameHeight / 2 },
    { dx: frameWidth + GAP, dy: frameHeight + GAP },
    { dx: -(componentWidth + GAP), dy: -(componentHeight + GAP) }
  ]

  for (let radius = 100; radius <= 2000; radius += 100) {
    for (const offset of gridOffsets) {
      const x = frameX + offset.dx + (offset.dx !== 0 ? radius * Math.sign(offset.dx) : 0)
      const y = frameY + offset.dy + (offset.dy !== 0 ? radius * Math.sign(offset.dy) : 0)

      if (
        !checkOverlap(x, y, componentWidth, componentHeight, allNodes, excludeIds)
      ) {
        return { x, y, position: `扩展区域(${radius}px)` }
      }
    }
  }

  return {
    x: frameX + frameWidth + GAP,
    y: frameY,
    position: '右侧'
  }
}

function findComponentSetRoot(component: ComponentNode): ComponentSetNode | null {
  const parent = component.parent
  if (parent && parent.type === 'COMPONENT_SET') {
    return parent
  }
  return null
}

async function collectAndLoadFonts(node: SceneNode) {
  const fonts: FontName[] = []

  function traverse(n: SceneNode) {
    if (n.type === 'TEXT') {
      const fontName = n.fontName as FontName
      if (fontName && !fonts.some(f => f.family === fontName.family && f.style === fontName.style)) {
        fonts.push(fontName)
      }
    }
    if ('children' in n) {
      for (const child of n.children) {
        traverse(child)
      }
    }
  }

  traverse(node)

  await Promise.all(fonts.map(font => figma.loadFontAsync(font)))
}

async function summonComponent() {
  const selection = figma.currentPage.selection

  if (selection.length === 0) {
    figma.notify('⚠️ 请先选择一个组件实例', { error: true, timeout: 2000 })
    return
  }

  const node = selection[0]

  if (node.type !== 'INSTANCE') {
    figma.notify('⚠️ 请选择组件实例', { error: true, timeout: 2000 })
    return
  }

  const instance = node as InstanceNode
  const mainComponent = await instance.getMainComponentAsync()

  if (!mainComponent) {
    figma.notify('⚠️ 此实例没有关联的主组件', { error: true, timeout: 2000 })
    return
  }

  if (mainComponent.remote) {
    figma.notify('⚠️ 无法移动组件库中的组件', { error: true, timeout: 2000 })
    return
  }

  const componentSet = findComponentSetRoot(mainComponent)
  const isComponentSet = !!componentSet
  const targetNode: ComponentNode | ComponentSetNode = isComponentSet ? componentSet : mainComponent

  const componentParent = targetNode.parent
  let isOnCurrentPage = false

  if (componentParent) {
    let current = componentParent
    while (current) {
      if (current.type === 'PAGE' && current.id === figma.currentPage.id) {
        isOnCurrentPage = true
        break
      }
      current = current.parent
    }
  }

  if (!isOnCurrentPage) {
    await collectAndLoadFonts(targetNode)
    figma.currentPage.appendChild(targetNode)
  }

  if (targetNode.parent !== figma.currentPage && targetNode.parent?.type !== 'SECTION') {
    await collectAndLoadFonts(targetNode)
    figma.currentPage.appendChild(targetNode)
  }

  const rootContainer = findRootContainer(instance)
  const referenceNode = rootContainer || instance

  const excludeIds = [instance.id, targetNode.id]

  let bestPos: { x: number; y: number; position: string }

  if (targetNode.parent?.type === 'SECTION') {
    const section = targetNode.parent as SceneNode

    let localX = instance.x
    let localY = instance.y
    let p: BaseNode | null = instance.parent
    while (p && p.type !== 'PAGE' && p.id !== section.id) {
      if ('x' in p && 'y' in p) {
        localX += (p as SceneNode).x
        localY += (p as SceneNode).y
      }
      p = p.parent
    }

    bestPos = calculateSmartPosition(
      { x: localX, y: localY, width: instance.width, height: instance.height } as SceneNode,
      targetNode.width,
      targetNode.height,
      excludeIds,
      section.children as SceneNode[]
    )

    targetNode.x = bestPos.x
    targetNode.y = bestPos.y
  } else {
    bestPos = calculateSmartPosition(
      referenceNode,
      targetNode.width,
      targetNode.height,
      excludeIds
    )

    targetNode.x = bestPos.x
    targetNode.y = bestPos.y
  }

  const currentZoom = figma.viewport.zoom
  figma.viewport.scrollAndZoomIntoView([targetNode])
  figma.viewport.zoom = currentZoom

  const nodeName = targetNode.name || '组件'
  const typeLabel = isComponentSet ? '组件集' : '组件'
  const positionLabel = rootContainer ? '容器' : '实例'
  const positionEmoji = getPositionEmoji(bestPos.position)

  figma.notify(`✨ ${typeLabel} "${nodeName}" 已召唤至${positionLabel}${bestPos.position} ${positionEmoji}`, {
    timeout: 5000
  })
}

summonComponent()
  .then(() => {
    figma.closePlugin()
  })
  .catch((err) => {
    console.error(err)
    const errorMsg = err instanceof Error ? err.message : '未知错误'
    figma.notify(`❌ 插件运行出错: ${errorMsg}`, { error: true, timeout: 3000 })
    figma.closePlugin()
  })
