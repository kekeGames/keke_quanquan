import { PopupBase } from "../popups/PopupBase";

/**
 * 弹窗管理器
 * @see PopupManager.ts https://gitee.com/ifaswind/eazax-ccc/blob/master/core/PopupManager.ts
 */
export default class PopupManager {
  /** 预制体表 */
  public static get prefabMap() {
    return this._prefabMap;
  }
  private static _prefabMap: Map<string, cc.Prefab> = new Map<
    string,
    cc.Prefab
  >();

  /** 节点表 */
  public static get nodeMap() {
    return this._nodeMap;
  }
  private static _nodeMap: Map<string, cc.Node> = new Map<string, cc.Node>();

  /** 等待队列 */
  public static get queue() {
    return this._queue.filter(item => item.popup && item.popup.isValid);
  }
  private static _queue: PopupRequest[] = [];

  /** 当前弹窗 */
  public static get current() {
    if (this._current && this._current.popup && this._current.popup.isValid) {
      return this._current;
    }
    return null;
  }
  private static _current: PopupRequest = null;

  /** 锁定状态（已有候选弹窗） */
  private static lockedForNext: boolean = false;

  /** 用于存放弹窗节点的容器节点（默认为 Canvas） */
  public static container: cc.Node = null;

  /** 连续展示弹窗的时间间隔（秒） */
  public static interval: number = 0.1;

  /** 弹窗动态加载开始回调 */
  public static loadStartCallback: Function = null;

  /** 弹窗动态加载结束回调 */
  public static loadFinishCallback: Function = null;

  /**
   * 展示弹窗，如果当前已有弹窗在展示中则加入等待队列
   * @param path 弹窗预制体相对路径（如：prefabs/MyPopup）
   * @param options 弹窗选项
   * @param mode 缓存模式
   * @param priority 是否优先展示
   * @example
   * const options = {
   *     title: 'hello',
   *     content: 'world'
   * }
   * PopupManager.show('prefabs/MyPopup', options);
   */
  public static show<Options>(
    path: string,
    options: Options = null,
    mode: PopupCacheMode = PopupCacheMode.Normal,
    priority: boolean = false
  ): Promise<PopupShowResult> {
    return new Promise(async res => {
      // 当前已有弹窗在展示中则加入等待队列
      if (this.current || this.lockedForNext) {
        this.push(path, options, mode, priority);
        return res(PopupShowResult.Wait);
      }

      // 保存为当前弹窗，阻止新的弹窗请求
      this._current = { path, options, mode };

      // 先在缓存中获取
      let node = this.getNodeFromCache(path);

      // 缓存中没有，动态加载预制体资源
      if (!cc.isValid(node)) {
        // 建议在动态加载时添加加载提示并屏蔽用户点击，避免多次点击，如下：
        // PopupManager.loadStartCallback = () => {
        //     LoadingTip.show();
        // }
        this.loadStartCallback && this.loadStartCallback();

        // 等待加载
        const prefab = await this.load(path);

        // 加载完成后隐藏加载提示，如下：
        // PopupManager.loadFinishCallback = () => {
        //     LoadingTip.hide();
        // }
        this.loadFinishCallback && this.loadFinishCallback();

        // 加载失败（一般是路径错误导致的）
        if (!cc.isValid(prefab)) {
          cc.warn("[PopupManager]", "弹窗加载失败", path);
          this._current = null;
          return res(PopupShowResult.Fail);
        }

        // 实例化节点
        node = cc.instantiate(prefab);
      }

      // 保存节点
      this._current.node = node;

      // 添加到场景中
      node.setParent(this.container || cc.Canvas.instance.node);
      // 显示在最上层
      node.setSiblingIndex(cc.macro.MAX_ZINDEX);

      // 获取继承自 PopupBase 的弹窗组件
      const popup = node.getComponent(PopupBase);
      if (popup) {
        this._current.popup = popup;
        // 设置完成回调
        popup.setFinishCallback(async () => {
          this.lockedForNext = this._queue.length > 0;
          this.recycle(path, node, mode);
          this._current = null;
          res(PopupShowResult.Done);
          // 延迟
          await new Promise(res => {
            cc.Canvas.instance.scheduleOnce(res, this.interval);
          });
          // 下一个弹窗
          this.next();
        });
        popup.show(options);
      } else {
        // 没有弹窗组件则直接打开节点
        node.active = true;
        res(PopupShowResult.Dirty);
      }
    });
  }

  /**
   * 隐藏当前弹窗
   */
  public static hideCurrent() {
    if (!this._current) {
      return;
    }
    if (this._current.popup) {
      this._current.popup.hide();
    } else if (this._current.node) {
      this._current.node.destroy();
      this.release(this._current.path);
      this._current = null;
    }
  }

  /**
   * 从缓存中获取节点
   * @param path 弹窗路径
   */
  private static getNodeFromCache(path: string): cc.Node {
    // 从节点表中获取
    if (this._nodeMap.has(path)) {
      const node = this._nodeMap.get(path);
      if (cc.isValid(node)) {
        return node;
      }
      this._nodeMap.delete(path);
    }
    // 从预制体表中获取
    if (this._prefabMap.has(path)) {
      const prefab = this._prefabMap.get(path);
      if (cc.isValid(prefab)) {
        return cc.instantiate(prefab);
      }
      this._prefabMap.delete(path);
    }
    // 无
    return null;
  }

  /**
   * 展示等待队列中的下一个弹窗
   */
  private static next(): void {
    if (this._current || this._queue.length === 0) {
      return;
    }
    const request = this._queue.shift();
    this.lockedForNext = false;
    this.show(request.path, request.options, request.mode);
  }
  static clearAllModal() {
    this._queue = [];
    if (this._current && this._current.popup) {
      this._current.popup.hide();
    }
    this.lockedForNext = false;
  }

  /**
   * 添加一个弹窗请求到等待队列中，如果当前没有展示中的弹窗则直接展示该弹窗。
   * @param path 弹窗预制体相对路径（如：prefabs/MyPopup）
   * @param options 弹窗选项
   * @param mode 缓存模式
   * @param priority 是否优先展示
   */
  public static push<Options>(
    path: string,
    options: Options = null,
    mode: PopupCacheMode = PopupCacheMode.Normal,
    priority: boolean = false
  ): void {
    // 直接展示
    if (!this._current && !this.lockedForNext) {
      this.show(path, options, mode);
      return;
    }
    // 加入队列
    if (priority) {
      this._queue.unshift({ path, options, mode });
    } else {
      this._queue.push({ path, options, mode });
    }
  }

  /**
   * 回收弹窗
   * @param path 弹窗路径
   * @param node 弹窗节点
   * @param mode 缓存模式
   */
  private static recycle(
    path: string,
    node: cc.Node,
    mode: PopupCacheMode
  ): void {
    switch (mode) {
      case PopupCacheMode.Once:
        node.destroy();
        if (this._nodeMap.has(path)) {
          this._nodeMap.delete(path);
        }
        this.release(path);
        break;
      case PopupCacheMode.Normal:
        node.destroy();
        if (this._nodeMap.has(path)) {
          this._nodeMap.delete(path);
        }
        break;
      case PopupCacheMode.Frequent:
        node.removeFromParent(false);
        if (!this._nodeMap.has(path)) {
          this._nodeMap.set(path, node);
        }
        break;
    }
  }

  /**
   * 加载并缓存弹窗预制体资源
   * @param path 弹窗路径
   */
  public static load(path: string): Promise<cc.Prefab> {
    return new Promise(res => {
      cc.resources.load(path, (error: Error, prefab: cc.Prefab) => {
        if (error) {
          res(null);
        } else {
          prefab.addRef(); // 增加引用计数
          this._prefabMap.set(path, prefab); // 缓存预制体
          res(prefab);
        }
      });
    });
  }

  /**
   * 尝试释放弹窗资源（注意：弹窗内部动态加载的资源请自行释放）
   * @param path 弹窗路径
   */
  public static release(path: string): void {
    // 移除节点
    let node = this._nodeMap.get(path);
    if (node) {
      this._nodeMap.delete(path);
      if (cc.isValid(node)) {
        node.destroy();
      }
      node = null;
    }
    // 移除预制体
    let prefab = this._prefabMap.get(path);
    if (prefab) {
      this._prefabMap.delete(path);
      prefab.decRef();
      prefab = null;
    }
  }
}

/** 弹窗请求 */
export interface PopupRequest {
  /** 弹窗预制体相对路径 */
  path: string;
  /** 弹窗选项 */
  options: any;
  /** 缓存模式 */
  mode: PopupCacheMode;
  /** 弹窗组件 */
  popup?: PopupBase;
  /** 弹窗节点 */
  node?: cc.Node;
}

/** 弹窗请求结果 */
export enum PopupShowResult {
  /** 展示成功（已关闭） */
  Done = 1,
  /** 展示失败（加载失败） */
  Fail = 2,
  /** 等待中（已加入等待队列） */
  Wait = 3,
  /** 直接展示（未找到弹窗组件） */
  Dirty = 4
}

/** 弹窗缓存模式 */
export enum PopupCacheMode {
  /** 一次性的（立即销毁节点，预制体资源随即释放） */
  Once = 1,
  /** 正常的（立即销毁节点，但是保留预制体资源） */
  Normal = 2,
  /** 频繁的（只关闭节点，且保留预制体资源） */
  Frequent = 3
}
window["PopupManager"] = PopupManager;
