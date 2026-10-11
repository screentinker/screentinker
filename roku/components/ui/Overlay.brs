sub init()
    m.label = m.top.findNode("label")
    m.panel = m.top.findNode("panel")
end sub
sub onMessage()
    m.label.text = m.top.message
    lines = m.top.message.Split(Chr(10)).Count()
    if lines < 1 then lines = 1
    h = 40 + lines * 44
    m.panel.height = h
    m.panel.translation = [0, 1080 - h]
    m.label.translation = [48, 1080 - h + 20]
end sub
