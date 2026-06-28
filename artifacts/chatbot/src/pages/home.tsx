import { useState, useRef, useEffect } from "react";
import {
  useListOpenaiConversations,
  useCreateOpenaiConversation,
  useGetOpenaiConversation,
  useDeleteOpenaiConversation,
  getGetOpenaiConversationQueryKey,
  getListOpenaiConversationsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import {
  Plus,
  MessageSquare,
  Trash2,
  Send,
  Bot,
  User,
  Loader2,
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  Cpu,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { format } from "date-fns";

type ConvWithArchive = {
  id: number;
  title: string;
  createdAt: string;
  archivedAt: string | null;
};

const SUGGESTED = [
  "What can you do?",
  "Give me 5 business ideas",
  "Help me write something",
];

export default function Home() {
  const [activeConvId, setActiveConvId] = useState<number | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const queryClient = useQueryClient();

  const { data: allConvs = [], isLoading: isLoadingConvs } =
    useListOpenaiConversations() as { data: ConvWithArchive[]; isLoading: boolean };

  const { data: archivedConvs = [], isLoading: isLoadingArchived } =
    useListOpenaiConversations({ query: { queryKey: ["openai-convs-archived"] } } as any) as {
      data: ConvWithArchive[];
      isLoading: boolean;
    };

  const activeConversations = (allConvs as ConvWithArchive[]).filter((c) => !c.archivedAt);

  const createConv = useCreateOpenaiConversation();
  const deleteConv = useDeleteOpenaiConversation();

  const { data: activeConv, isLoading: isLoadingConv } = useGetOpenaiConversation(
    activeConvId as number,
    { query: { enabled: !!activeConvId, queryKey: getGetOpenaiConversationQueryKey(activeConvId as number) } }
  );

  const [input, setInput] = useState("");
  const [streamingMessage, setStreamingMessage] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [optimisticMessages, setOptimisticMessages] = useState<
    Array<{ id: number; role: string; content: string; createdAt: string }>
  >([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [activeConv?.messages, optimisticMessages, streamingMessage]);

  useEffect(() => {
    setOptimisticMessages([]);
    setStreamingMessage("");
    setIsStreaming(false);
  }, [activeConvId]);

  // Fetch archived list when section is opened
  const fetchArchived = async (): Promise<ConvWithArchive[]> => {
    const res = await fetch("/api/openai/conversations?archived=true");
    return res.json();
  };

  const [archivedList, setArchivedList] = useState<ConvWithArchive[]>([]);
  useEffect(() => {
    if (showArchived) {
      fetchArchived().then(setArchivedList);
    }
  }, [showArchived]);

  const invalidateLists = () => {
    queryClient.invalidateQueries({ queryKey: getListOpenaiConversationsQueryKey() });
  };

  const streamMessage = async (convId: number, content: string) => {
    setIsStreaming(true);
    setStreamingMessage("");
    try {
      const res = await fetch(`/api/openai/conversations/${convId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });

      if (!res.ok) throw new Error("Failed to send message");

      const reader = res.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      let streamContent = "";
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const dataStr = line.slice(5).trim();
          if (!dataStr) continue;
          try {
            const data = JSON.parse(dataStr);
            if (data.content) {
              streamContent += data.content;
              setStreamingMessage(streamContent);
              scrollToBottom();
            }
          } catch {
            // skip malformed
          }
        }
      }

      queryClient.invalidateQueries({ queryKey: getGetOpenaiConversationQueryKey(convId) });
    } catch (err) {
      console.error(err);
    } finally {
      setIsStreaming(false);
      setStreamingMessage("");
      setOptimisticMessages([]);
    }
  };

  const handleSend = async (text?: string) => {
    const userMsgContent = (text ?? input).trim();
    if (!userMsgContent || isStreaming) return;

    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    if (!activeConvId) {
      createConv.mutate(
        { data: { title: userMsgContent.substring(0, 40) + (userMsgContent.length > 40 ? "..." : "") } },
        {
          onSuccess: async (conv) => {
            setActiveConvId(conv.id);
            invalidateLists();
            setOptimisticMessages([
              { id: Date.now(), role: "user", content: userMsgContent, createdAt: new Date().toISOString() },
            ]);
            await streamMessage(conv.id, userMsgContent);
          },
        }
      );
    } else {
      setOptimisticMessages((prev) => [
        ...prev,
        { id: Date.now(), role: "user", content: userMsgContent, createdAt: new Date().toISOString() },
      ]);
      await streamMessage(activeConvId, userMsgContent);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleDelete = (e: React.MouseEvent, id: number) => {
    e.stopPropagation();
    if (!window.confirm("Delete this conversation? This cannot be undone.")) return;
    deleteConv.mutate(
      { id },
      {
        onSuccess: () => {
          invalidateLists();
          if (activeConvId === id) setActiveConvId(null);
        },
      }
    );
  };

  const handleArchive = async (e: React.MouseEvent, id: number) => {
    e.stopPropagation();
    await fetch(`/api/openai/conversations/${id}/archive`, { method: "PATCH" });
    invalidateLists();
    if (showArchived) fetchArchived().then(setArchivedList);
    if (activeConvId === id) setActiveConvId(null);
  };

  const handleUnarchive = async (e: React.MouseEvent, id: number) => {
    e.stopPropagation();
    await fetch(`/api/openai/conversations/${id}/unarchive`, { method: "PATCH" });
    invalidateLists();
    fetchArchived().then(setArchivedList);
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    e.target.style.height = "auto";
    e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
  };

  const allMessages = [...(activeConv?.messages || []), ...optimisticMessages];
  const isNewChat = !activeConvId && optimisticMessages.length === 0;

  return (
    <div className="flex h-screen w-full bg-background overflow-hidden text-foreground">
      {/* Sidebar */}
      <div className="w-64 flex-shrink-0 bg-sidebar border-r border-sidebar-border flex flex-col">
        {/* Sidebar header */}
        <div className="p-4 border-b border-sidebar-border flex items-center gap-3">
          <div className="h-8 w-8 rounded-lg bg-primary/15 border border-primary/20 flex items-center justify-center flex-shrink-0">
            <Cpu className="h-4 w-4 text-primary" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold leading-tight text-sidebar-foreground truncate">AI Assistant</p>
            <p className="text-[10px] text-primary/80 leading-tight">Powered by Llama 3.1</p>
          </div>
        </div>

        {/* New Chat button */}
        <div className="px-3 pt-3 pb-1">
          <Button
            className="w-full justify-start gap-2 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 shadow-none"
            onClick={() => setActiveConvId(null)}
            data-testid="button-new-chat"
          >
            <Plus className="h-4 w-4" />
            New Chat
          </Button>
        </div>

        {/* Conversation list */}
        <ScrollArea className="flex-1 px-3 py-2">
          <div className="space-y-0.5">
            {isLoadingConvs ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              activeConversations.map((conv) => (
                <div
                  key={conv.id}
                  onClick={() => setActiveConvId(conv.id)}
                  data-testid={`conv-item-${conv.id}`}
                  className={cn(
                    "group flex items-center justify-between px-3 py-2.5 rounded-md cursor-pointer transition-colors text-sm",
                    activeConvId === conv.id
                      ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                      : "text-sidebar-foreground hover:bg-sidebar-accent/50"
                  )}
                >
                  <div className="flex items-center gap-2 overflow-hidden flex-1 min-w-0">
                    <MessageSquare className="h-4 w-4 flex-shrink-0 opacity-60" />
                    <span className="truncate">{conv.title || "New Conversation"}</span>
                  </div>
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 hover:bg-primary/10 hover:text-primary"
                      onClick={(e) => handleArchive(e, conv.id)}
                      title="Archive"
                      data-testid={`button-archive-${conv.id}`}
                    >
                      <Archive className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 hover:bg-destructive/10 hover:text-destructive"
                      onClick={(e) => handleDelete(e, conv.id)}
                      title="Delete"
                      data-testid={`button-delete-${conv.id}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))
            )}

            {activeConversations.length === 0 && !isLoadingConvs && (
              <div className="text-center py-6 text-xs text-sidebar-foreground/40">
                No conversations yet
              </div>
            )}

            {/* Archived section */}
            <div className="mt-3">
              <button
                className="flex items-center gap-1.5 w-full px-2 py-1.5 text-xs text-sidebar-foreground/50 hover:text-sidebar-foreground/80 transition-colors rounded"
                onClick={() => setShowArchived((v) => !v)}
                data-testid="button-toggle-archived"
              >
                {showArchived ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                <Archive className="h-3 w-3" />
                Archived
              </button>

              {showArchived && (
                <div className="mt-0.5 space-y-0.5">
                  {archivedList.length === 0 ? (
                    <div className="text-center py-3 text-xs text-sidebar-foreground/30">
                      No archived chats
                    </div>
                  ) : (
                    archivedList.map((conv) => (
                      <div
                        key={conv.id}
                        onClick={() => setActiveConvId(conv.id)}
                        data-testid={`conv-archived-${conv.id}`}
                        className={cn(
                          "group flex items-center justify-between px-3 py-2 rounded-md cursor-pointer transition-colors text-sm opacity-60 hover:opacity-100",
                          activeConvId === conv.id
                            ? "bg-sidebar-accent text-sidebar-accent-foreground"
                            : "text-sidebar-foreground hover:bg-sidebar-accent/40"
                        )}
                      >
                        <div className="flex items-center gap-2 overflow-hidden flex-1 min-w-0">
                          <Archive className="h-3.5 w-3.5 flex-shrink-0" />
                          <span className="truncate text-xs">{conv.title}</span>
                        </div>
                        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 hover:bg-primary/10 hover:text-primary"
                            onClick={(e) => handleUnarchive(e, conv.id)}
                            title="Unarchive"
                            data-testid={`button-unarchive-${conv.id}`}
                          >
                            <ArchiveRestore className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 hover:bg-destructive/10 hover:text-destructive"
                            onClick={(e) => handleDelete(e, conv.id)}
                            title="Delete"
                            data-testid={`button-delete-archived-${conv.id}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        </ScrollArea>
      </div>

      {/* Main Area */}
      <div className="flex-1 flex flex-col min-w-0 bg-background">
        {/* Top header bar */}
        <header className="h-14 flex-shrink-0 border-b border-border flex items-center px-6 gap-3 bg-background/80 backdrop-blur-sm z-10">
          <div className="h-8 w-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0">
            <Bot className="h-4 w-4 text-primary" />
          </div>
          <div>
            <p className="text-sm font-semibold leading-tight">AI Assistant</p>
            <p className="text-[10px] text-muted-foreground leading-tight">Powered by Llama 3.1</p>
          </div>
          {activeConvId && activeConv?.title && (
            <>
              <span className="text-border mx-1">|</span>
              <span className="text-sm text-muted-foreground truncate">{activeConv.title}</span>
            </>
          )}
        </header>

        {/* Messages */}
        <ScrollArea className="flex-1 p-6">
          <div className="max-w-3xl mx-auto space-y-6 pb-24">
            {isNewChat ? (
              /* Welcome state */
              <div className="flex flex-col items-center justify-center h-[50vh] text-center space-y-6">
                <div className="h-16 w-16 rounded-2xl bg-primary/10 flex items-center justify-center border border-primary/20">
                  <Bot className="h-8 w-8 text-primary" />
                </div>
                <div className="space-y-2">
                  <h2 className="text-2xl font-semibold tracking-tight">Hi! I'm your AI assistant.</h2>
                  <p className="text-muted-foreground text-sm">Ask me anything.</p>
                </div>
                <div className="flex flex-col gap-2 w-full max-w-sm">
                  {SUGGESTED.map((q) => (
                    <button
                      key={q}
                      onClick={() => handleSend(q)}
                      data-testid={`button-suggested-${q}`}
                      className="w-full text-left px-4 py-3 rounded-xl border border-border bg-card hover:bg-sidebar-accent hover:border-primary/30 text-sm text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            ) : isLoadingConv && activeConvId && optimisticMessages.length === 0 ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <>
                {allMessages.map((msg, i) => (
                  <div
                    key={msg.id || i}
                    className={cn(
                      "flex gap-4 message-fade-in max-w-[85%]",
                      msg.role === "user" ? "ml-auto flex-row-reverse" : "mr-auto"
                    )}
                  >
                    <div
                      className={cn(
                        "h-8 w-8 rounded-full flex items-center justify-center flex-shrink-0 border shadow-sm",
                        msg.role === "user"
                          ? "bg-secondary border-border"
                          : "bg-primary border-primary text-primary-foreground"
                      )}
                    >
                      {msg.role === "user" ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
                    </div>
                    <div className={cn("flex flex-col gap-1", msg.role === "user" ? "items-end" : "items-start")}>
                      <div
                        className={cn(
                          "px-4 py-3 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap",
                          msg.role === "user"
                            ? "bg-secondary text-secondary-foreground rounded-tr-sm"
                            : "bg-card border border-border shadow-sm rounded-tl-sm"
                        )}
                      >
                        {msg.content}
                      </div>
                      <span className="text-[10px] text-muted-foreground/60 px-1 font-mono">
                        {msg.createdAt && format(new Date(msg.createdAt), "h:mm a")}
                      </span>
                    </div>
                  </div>
                ))}

                {/* Streaming bubble */}
                {isStreaming && streamingMessage && (
                  <div className="flex gap-4 message-fade-in max-w-[85%] mr-auto">
                    <div className="h-8 w-8 rounded-full flex items-center justify-center flex-shrink-0 border bg-primary border-primary text-primary-foreground shadow-sm">
                      <Bot className="h-4 w-4" />
                    </div>
                    <div className="flex flex-col gap-1 items-start">
                      <div className="px-4 py-3 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap bg-card border border-border shadow-sm rounded-tl-sm">
                        {streamingMessage}
                        <span className="typewriter-cursor" />
                      </div>
                    </div>
                  </div>
                )}

                {/* Typing dots */}
                {isStreaming && !streamingMessage && (
                  <div className="flex gap-4 message-fade-in max-w-[85%] mr-auto">
                    <div className="h-8 w-8 rounded-full flex items-center justify-center flex-shrink-0 border bg-primary border-primary text-primary-foreground shadow-sm">
                      <Bot className="h-4 w-4" />
                    </div>
                    <div className="flex flex-col gap-1 items-start">
                      <div className="px-4 py-4 rounded-2xl bg-card border border-border shadow-sm rounded-tl-sm flex items-center gap-1.5 h-11">
                        <svg className="h-1.5 w-1.5 text-muted-foreground typing-dot" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" /></svg>
                        <svg className="h-1.5 w-1.5 text-muted-foreground typing-dot" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" /></svg>
                        <svg className="h-1.5 w-1.5 text-muted-foreground typing-dot" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" /></svg>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
            <div ref={messagesEndRef} />
          </div>
        </ScrollArea>

        {/* Input */}
        <div className="p-4 bg-background/80 backdrop-blur-sm border-t border-border">
          <div className="max-w-3xl mx-auto relative flex items-end shadow-sm bg-card rounded-xl border border-input focus-within:ring-1 focus-within:ring-ring focus-within:border-ring transition-shadow">
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => { setInput(e.target.value); handleInput(e); }}
              onKeyDown={handleKeyDown}
              placeholder="Message AI..."
              data-testid="input-message"
              className="min-h-[52px] max-h-[200px] w-full resize-none border-0 shadow-none focus-visible:ring-0 rounded-xl bg-transparent py-3.5 pl-4 pr-12 text-sm text-card-foreground font-mono"
              rows={1}
            />
            <Button
              size="icon"
              className={cn(
                "absolute right-2 bottom-2 h-9 w-9 rounded-lg transition-all",
                input.trim() && !isStreaming
                  ? "bg-primary text-primary-foreground hover:bg-primary/90"
                  : "bg-secondary text-muted-foreground opacity-50 cursor-not-allowed"
              )}
              onClick={() => handleSend()}
              disabled={!input.trim() || isStreaming}
              data-testid="button-send"
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
          <div className="max-w-3xl mx-auto text-center mt-2">
            <span className="text-[10px] text-muted-foreground/50">
              AI can make mistakes. Consider verifying important information.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
