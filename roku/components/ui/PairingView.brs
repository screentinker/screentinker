sub init()
    m.codeLabel = m.top.findNode("codeLabel")
    m.howLabel = m.top.findNode("howLabel")
end sub
sub onChange()
    c = m.top.code
    ' "123456" reads as "123 456" from across a room
    if Len(c) = 6 then c = Left(c, 3) + " " + Right(c, 3)
    m.codeLabel.text = c
    m.howLabel.text = "In the ScreenTinker dashboard (" + m.top.server + "), open Displays → Add display and enter this code."
end sub
