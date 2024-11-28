// モーダル表示処理
$('#imageModal').on('show.bs.modal', function (event) {
    var img = $(event.relatedTarget);
    var url = img.data('url');
    var modal = $(this);
    modal.find('#modalImage').attr('src', url);
});

// Likeアイコンのクリックイベント
document.querySelectorAll('.like-icon').forEach(icon => {
    icon.addEventListener('click', async () => {
        const blobName = icon.dataset.name;
        try {
            const response = await fetch(`/like/${blobName}`, { method: 'POST' });
            const data = await response.json();
            if (data.success) {
                document.getElementById(`like-count-${blobName}`).innerText = data.likes;
            }
        } catch (error) {
            console.error('Error liking image:', error);
        }
    });
});
