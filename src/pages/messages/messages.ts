import { Component, ElementRef, OnDestroy, OnInit } from '@angular/core';
import { Messages } from 'api/collections';
import { Chat, Message } from 'api/models';
import { ModalController, NavParams, PopoverController } from 'ionic-angular';
import { MeteorObservable } from 'meteor-rxjs';
import { Meteor } from 'meteor/meteor';
import { _ } from 'meteor/underscore';
import * as Moment from 'moment';
import { Observable, Subscription, Subscriber } from 'rxjs';
import { PictureService } from '../../services/picture';
import { MessagesAttachmentsComponent } from './messages-attachments';
import { MessagesOptionsComponent } from './messages-options';
import { ShowPictureComponent } from './show-picture';

@Component({
  selector: 'messages-page',
  templateUrl: 'messages.html'
})
export class MessagesPage implements OnInit, OnDestroy {
  autoScroller: MutationObserver;
  loadingMessages: Boolean;
  message: string = '';
  messagesBatchCounter = 0;
  messagesComputation: Subscription;
  messagesDayGroups: Observable<Message[]>;
  picture: string;
  scrollOffset = 0;
  selectedChat: Chat;
  senderId: string;
  title: string;

  constructor(
    navParams: NavParams,
    private el: ElementRef,
    private pictureService: PictureService,
    private popoverCtrl: PopoverController,
    private modalCtrl: ModalController
  ) {
    this.selectedChat = <Chat>navParams.get('chat');
    this.title = this.selectedChat.title;
    this.picture = this.selectedChat.picture;
    this.senderId = Meteor.userId();
  }

  private get messagesPageContent(): Element {
    return this.el.nativeElement.querySelector('.messages-page-content');
  }

  private get messagesPageFooter(): Element {
    return this.el.nativeElement.querySelector('.messages-page-footer');
  }

  private get messagesList(): Element {
    return this.messagesPageContent.querySelector('.messages');
  }

  private get messageEditor(): HTMLInputElement {
    return <HTMLInputElement>this.messagesPageFooter.querySelector('.message-editor');
  }

  private get scroller(): Element {
    return this.messagesList.querySelector('.scroll-content');
  }

  ngOnInit() {
    this.autoScroller = this.autoScroll();
    this.subscribeMessages();

    // Get total messages count in database so we can have an indication of when to
    // stop the auto-subscriber
    MeteorObservable.call('countMessages').subscribe((messagesCount: number) => {
      Observable
        // Chain every scroll event
        .fromEvent(this.scroller, 'scroll')
        // Remove the scroll listener once all messages have been fetched
        .takeUntil(this.autoRemoveScrollListener(messagesCount))
        // Filter event handling unless we're at the top of the page
        .filter(() => !this.scroller.scrollTop)
        // Prohibit parallel subscriptions
        .filter(() => !this.loadingMessages)
        // Invoke the messages subscription once all the requirements have been met
        .forEach(() => this.subscribeMessages());
    });
  }

  ngOnDestroy() {
    this.autoScroller.disconnect();
  }

  onInputKeypress({ keyCode }: KeyboardEvent): void {
    if (keyCode == 13) {
      this.sendTextMessage();
    }
  }

  showAttachments(): void {
    const popover = this.popoverCtrl.create(MessagesAttachmentsComponent, {
      chat: this.selectedChat
    }, {
      // Hooking components
      cssClass: 'attachments-popover'
    });

    popover.onDidDismiss((params) => {
      const file: File = params.selectedPicture;
      this.sendPictureMessage(file);
    });

    popover.present();
  }

  showOptions(): void {
    const popover = this.popoverCtrl.create(MessagesOptionsComponent, {
      chat: this.selectedChat
    }, {
      cssClass: 'options-popover messages-options-popover'
    });

    popover.present();
  }

  // Subscribes to the relevant set of messages
  subscribeMessages(): void {
    // A flag which indicates if there's a subscription in process
    this.loadingMessages = true;
    // A custom offset to be used to re-adjust the scrolling position once
    // new dataset is fetched
    this.scrollOffset = this.scroller.scrollHeight;

    MeteorObservable.subscribe('messages',
      this.selectedChat._id,
      ++this.messagesBatchCounter
    ).subscribe(() => {
      // Keep tracking changes in the dataset and re-render the view
      if (!this.messagesComputation) this.messagesComputation = this.autorunMessages();
      // Allow incoming subscription requests
      this.loadingMessages = false;
    });
  }

  // Removes the scroll listener once all messages from the past were fetched
  autoRemoveScrollListener<T>(messagesCount: number): Observable<T> {
    return Observable.create((observer: Subscriber<T>) => {
      Messages.find().subscribe((messages) => {
        // Once all messages have been fetched
        if (messagesCount != messages.length) return;
        // Signal to stop listening to the scroll event
        observer.next();
        // Finish the observation to prevent unnecessary calculations
        observer.complete();
      });
    });
  }

  // Detects changes in the messages dataset and re-renders the view
  autorunMessages(): Subscription {
    return MeteorObservable.autorun().subscribe(() => {
      this.messagesDayGroups = this.findMessagesDayGroups();
    });
  }

  // Finds relevant messages and groups them by their creation day
  findMessagesDayGroups(): Observable<Message[]> {
    return Messages.find({
      chatId: this.selectedChat._id
    }, {
      sort: { createdAt: 1 }
    })
    .map((messages: Message[]) => {
      const format = 'D MMMM Y';

      // Compose missing data that we would like to show in the view
      messages.forEach((message) => {
        message.ownership = this.senderId == message.senderId ? 'mine' : 'other';
        return message;
      });

      // Group by creation day
      messages = _.groupBy(messages, (message) => {
        return Moment(message).format(format);
      });

      // Transform dictionary into an array since Angular's view engine doesn't know how
      // to iterate through it
      return Object.keys(messages).map((timestamp) => {
        return {
          timestamp: timestamp,
          messages: messages[timestamp],
          today: Moment().format(format) == timestamp
        };
      });
    });
  }

  showPicture({ target }: Event) {
    const modal = this.modalCtrl.create(ShowPictureComponent, {
      pictureSrc: (<HTMLImageElement>target).src
    });

    modal.present();
  }

  sendPictureMessage(file: File): void {
    this.pictureService.upload(file).then((picture) => {
      MeteorObservable.call('addMessage', 'picture',
        this.selectedChat._id,
        picture.url
      ).zone().subscribe();
    });
  }

  sendTextMessage(): void {
    // If message was yet to be typed, abort
    if (!this.message) return;

    MeteorObservable.call('addMessage', 'text',
      this.selectedChat._id,
      this.message
    ).zone().subscribe(() => {
      // Zero the input field
      this.message = '';
    });
  }

  // Detects changes in the scroll view and scrolls automatically
  autoScroll(): MutationObserver {
    const autoScroller = new MutationObserver(this.scrollDown.bind(this));

    autoScroller.observe(this.messagesList, {
      childList: true,
      subtree: true
    });

    return autoScroller;
  }

  scrollDown(): void {
    // Don't scroll down if messages subscription is being loaded
    if (this.loadingMessages) return;

    // Scroll down and apply specified offset
    this.scroller.scrollTop = this.scroller.scrollHeight - this.scrollOffset;
    // Zero offset for next invocation
    this.scrollOffset = 0;
  }
}

